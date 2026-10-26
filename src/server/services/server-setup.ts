import { createHash } from "node:crypto";
import { stringify as stringifyYaml } from "yaml";
import {
	BASE_COMMANDS,
	BASE_PACKAGES,
	type HostOsFamily,
	hostOsFamilies,
	hostOsFamily,
	SUPPORTED_OS_IDS,
} from "#/config/host-os.ts";
import { DOCKER_LABELS, labelValueTemplate } from "#/config/identifiers.ts";
import type {
	JobLogArgs,
	JobLogEvent,
	JobStep,
} from "#/config/job-log-events.ts";
import { getConfig, hostPaths, traefikVersion } from "#/config/server.ts";
import type { JobLogger } from "#/features/deployments/deployments.server.ts";
import { AppError, commandError } from "#/utils/error.ts";
import { errorInfoOf } from "./error-info";
import { type Executor, shellQuote as q } from "./executor";
import {
	claimServerScript,
	evaluateServerOwnership,
	OWNER_LABEL,
	type ServerOwnership,
	serverOwnershipScript,
} from "./ownership";

/** Host facts probed before bootstrap (see `gatherSystemInfo`). */
interface SystemInfo {
	/** Family of the host (#/config/host-os.ts) that installs packages and Docker. */
	family: HostOsFamily;
	os: string;
	osVersion: string;
	architecture: string;
	dockerInstalled: boolean;
	dockerVersion: string | null;
	/** Whether nothing listens on 80/443 yet (Traefik needs both). */
	portsAvailable: {
		port80: boolean;
		port443: boolean;
	};
	traefikContainer: boolean;
}

/**
 * Outcome of `bootstrapServer`. Failures are returned, not thrown: `error`
 * holds the failure and `steps` the progress events emitted so far.
 */
export interface BootstrapResult {
	success: boolean;
	steps: JobLogEvent[];
	error: unknown;
	os: string | null;
	dockerVersion: string | null;
	/** Set when refused because another instance manages the server. */
	foreignOwner?: string;
	/**
	 * Whether the server may have been changed (a step past the read-only
	 * checks ran). False: it is exactly as before.
	 */
	changed: boolean;
}

/** Receives progress events and raw output (streamed into the job log). */
export type SetupLogCallback = JobLogger;

/**
 * One round-trip that prints `key=value` lines describing the host.
 */
export const systemInfoScript = () =>
	[
		"echo uid=$(id -u)",
		...[
			...new Set(
				Object.values(hostOsFamilies).map((family) => family.packageManager),
			),
		].map((tool) => `echo pm_${tool}=$(command -v ${tool} || echo missing)`),
		"echo systemctl=$(command -v systemctl || echo missing)",
		`echo os_id=$(grep '^ID=' /etc/os-release 2>/dev/null | cut -d= -f2 | tr -d '"')`,
		`echo os=$(grep '^PRETTY_NAME=' /etc/os-release 2>/dev/null | cut -d= -f2 | tr -d '"')`,
		"echo kernel=$(uname -r)",
		"echo arch=$(uname -m)",
		"echo docker=$(docker --version 2>/dev/null || echo not_installed)",
		"echo port80=$(ss -tln 2>/dev/null | grep -q ':80 ' && echo used || echo available)",
		"echo port443=$(ss -tln 2>/dev/null | grep -q ':443 ' && echo used || echo available)",
		`echo traefik=$(docker inspect -f '{{.State.Status}}' ${q(getConfig().TRAEFIK_CONTAINER)} 2>/dev/null || echo missing)`,
	].join("\n");

export function parseKeyValueLines(output: string): Record<string, string> {
	const values: Record<string, string> = {};
	for (const line of output.split("\n")) {
		const index = line.indexOf("=");
		if (index <= 0) continue;
		values[line.slice(0, index).trim()] = line.slice(index + 1).trim();
	}
	return values;
}

export function parseDockerVersion(output: string): string | null {
	return output.match(/Docker version ([\d.]+)/)?.[1] ?? null;
}

/** Whether `line` is package manager chatter of `family` (dropped from logs). */
export function isPackageNoise(family: HostOsFamily, line: string): boolean {
	return family.noise.test(line.trim());
}

function logUseful(
	family: HostOsFamily,
	text: string,
	onLog?: SetupLogCallback,
): void {
	const lines = text
		.split(/\r?\n/)
		.filter((line) => line.trim() && !isPackageNoise(family, line));
	if (lines.length) onLog?.log(lines.join("\n"));
}

/**
 * Gather system information and validate the host can be bootstrapped.
 */
export async function gatherSystemInfo(
	executor: Executor,
	onLog?: SetupLogCallback,
): Promise<SystemInfo> {
	onLog?.event("setup.checking_root");
	const result = await executor.exec(systemInfoScript());
	const values = parseKeyValueLines(result.stdout);

	if (
		result.exitCode !== 0 ||
		values.uid !== "0" ||
		values.systemctl === "missing"
	) {
		throw new AppError("SETUP_ROOT_REQUIRED");
	}
	const family = hostOsFamily(values.os_id);
	if (!family) {
		throw new AppError("SETUP_DISTRO_UNSUPPORTED", {
			distro: values.os_id || "?",
			supported: { $list: [...SUPPORTED_OS_IDS] },
		});
	}
	const manager = values[`pm_${family.packageManager}`];
	if (!manager || manager === "missing") {
		throw new AppError("SETUP_PACKAGE_MANAGER_MISSING", {
			tool: family.packageManager,
		});
	}

	const dockerInstalled = !!values.docker && values.docker !== "not_installed";
	const info: SystemInfo = {
		family,
		os: values.os || values.os_id || "Unknown",
		osVersion: values.kernel ?? "",
		architecture: values.arch ?? "",
		dockerInstalled,
		dockerVersion: dockerInstalled ? parseDockerVersion(values.docker) : null,
		portsAvailable: {
			port80: values.port80 === "available",
			port443: values.port443 === "available",
		},
		traefikContainer: !!values.traefik && values.traefik !== "missing",
	};

	onLog?.event("setup.detected", {
		os: info.os,
		arch: info.architecture,
		kernel: info.osVersion,
	});
	return info;
}

async function installBasePackages(
	executor: Executor,
	family: HostOsFamily,
	onLog?: SetupLogCallback,
): Promise<void> {
	const check = await executor.exec(
		`command -v ${BASE_COMMANDS.join(" ")} >/dev/null 2>&1 && test -d /etc/ssl/certs`,
	);
	if (check.exitCode === 0) {
		onLog?.event("setup.packages_present");
		return;
	}
	onLog?.event("setup.packages_installing");
	const result = await executor.exec(
		family.installPackagesScript(BASE_PACKAGES),
	);
	if (result.exitCode !== 0) {
		throw commandError("SETUP_PACKAGES_FAILED", result.stderr);
	}
	onLog?.event("setup.packages_installed");
}

/**
 * Install Docker if not present. Idempotent.
 */
async function installDocker(
	executor: Executor,
	family: HostOsFamily,
	onLog?: SetupLogCallback,
): Promise<{ installed: boolean; version: string | null }> {
	const check = await executor.exec("docker --version 2>/dev/null");
	if (check.exitCode === 0) {
		const version = parseDockerVersion(check.stdout);
		onLog?.event("setup.docker_present", { version: version ?? "?" });
		return { installed: true, version };
	}

	onLog?.event("setup.docker_installing");
	const result = await executor.exec(family.installDockerScript(), {
		onStdout: (text) => logUseful(family, text, onLog),
		onStderr: (text) => logUseful(family, text, onLog),
	});
	if (result.exitCode !== 0) {
		throw commandError("SETUP_DOCKER_FAILED", result.stderr);
	}

	const verify = await executor.exec("docker --version");
	const version = parseDockerVersion(verify.stdout);
	onLog?.event("setup.docker_installed", { version: version ?? "?" });
	return { installed: true, version };
}

/**
 * Ensure the shared app network exists. Single-node: a plain bridge network
 * (no Swarm, so no 2377/7946/4789 ports exposed). An existing network with
 * that name (e.g. an attachable overlay from an older bootstrap) is kept as
 * is; an active Swarm is left alone.
 */
async function ensureSharedNetwork(
	executor: Executor,
	onLog?: SetupLogCallback,
): Promise<void> {
	const network = getConfig().NITROBASE_NETWORK;
	onLog?.event("setup.network_ensuring", { network });
	const result = await executor.exec(`
		set -e
		net=${q(network)}
		if docker network inspect "$net" >/dev/null 2>&1; then
			echo "driver=$(docker network inspect -f '{{.Driver}}' "$net")"
		else
			docker network create --driver bridge "$net" >/dev/null
			echo "driver=bridge (created)"
		fi
	`);
	if (result.exitCode !== 0) {
		throw new AppError("SETUP_NETWORK_FAILED", {
			network,
			detail: result.stderr,
		});
	}
	onLog?.event("setup.network_ready", {
		network,
		driver: result.stdout.replace("driver=", ""),
	});
}

/**
 * The private Traefik ↔ cloudflared network (fixed subnet, so Traefik's
 * tunnel entrypoint can bind its own address there). Pure (tested).
 */
export function tunnelNetworkScript(config = getConfig()): string {
	const net = q(config.TUNNEL_NETWORK);
	return `
		set -e
		if ! docker network inspect ${net} >/dev/null 2>&1; then
			docker network create --driver bridge --subnet ${q(config.TUNNEL_SUBNET)} ${net} >/dev/null
		fi
		subnet=$(docker network inspect -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}' ${net})
		if [ "$subnet" != ${q(config.TUNNEL_SUBNET)} ]; then
			echo "${config.TUNNEL_NETWORK} has subnet $subnet, expected ${config.TUNNEL_SUBNET} (TUNNEL_SUBNET)" >&2
			exit 1
		fi
	`;
}

async function ensureTunnelNetwork(
	executor: Executor,
	onLog?: SetupLogCallback,
): Promise<void> {
	const config = getConfig();
	const result = await executor.exec(tunnelNetworkScript(config));
	if (result.exitCode !== 0) {
		throw new AppError("SETUP_NETWORK_FAILED", {
			network: config.TUNNEL_NETWORK,
			detail: result.stderr.trim(),
		});
	}
	onLog?.event("setup.tunnel_network_ready", {
		network: config.TUNNEL_NETWORK,
	});
}

export function traefikStaticConfig(acmeEmail: string): string {
	const config = getConfig();
	const paths = hostPaths(config);
	return stringifyYaml({
		entryPoints: {
			// HTTP→HTTPS redirects are per router (app dynamic config), so
			// HTTP-only routes stay possible.
			web: { address: ":80" },
			websecure: { address: ":443" },
			// Cloudflare Tunnel only: bound to Traefik's address in the private
			// tunnel network (never published, unreachable from app networks).
			tunnel: {
				address: `${config.TRAEFIK_TUNNEL_IP}:${config.TRAEFIK_TUNNEL_PORT}`,
			},
		},
		// File provider only: routes come from Nitrobase-generated files, so
		// container labels can never claim another app's domain.
		providers: {
			file: { directory: paths.traefikDynamic, watch: true },
		},
		certificatesResolvers: {
			[config.TRAEFIK_CERT_RESOLVER]: {
				acme: {
					email: acmeEmail,
					storage: paths.acmeFile,
					httpChallenge: { entryPoint: "web" },
				},
			},
		},
		log: { level: "INFO" },
		accessLog: {},
	});
}

/** Shared Traefik middlewares (HSTS from TRAEFIK_HSTS_*). */
function traefikMiddlewaresConfig(): string {
	const config = getConfig();
	return stringifyYaml({
		http: {
			middlewares: {
				"secure-headers": {
					headers: {
						sslRedirect: true,
						stsSeconds: config.TRAEFIK_HSTS_SECONDS,
						stsIncludeSubdomains: true,
						stsPreload: config.TRAEFIK_HSTS_PRELOAD,
						forceSTSHeader: true,
						frameDeny: true,
						contentTypeNosniff: true,
						browserXssFilter: true,
					},
				},
			},
		},
	});
}

/** Hash of everything that requires recreating the Traefik container. */
export function traefikConfigHash(
	staticConfig: string,
	options: { publishPorts?: boolean; instanceId?: string } = {},
): string {
	const hash = createHash("sha256")
		.update(getConfig().TRAEFIK_IMAGE)
		.update("\0")
		.update(staticConfig);
	// Same hash as before for published ports (no needless recreate on upgrade).
	if (options.publishPorts === false) hash.update("\0tunnel-only");
	// The owner label is part of the container: retag = recreate (once).
	if (options.instanceId) hash.update(`\0owner:${options.instanceId}`);
	return hash.digest("hex").slice(0, 16);
}

/** `-p` flags of the Traefik container (none for a tunnel-only server). */
export function traefikPortFlags(publishPorts: boolean): string {
	return publishPorts
		? "-p 80:80 \\\n\t\t\t-p 443:443/tcp \\\n\t\t\t-p 443:443/udp \\"
		: // Keeps the line continuation of the `docker run` command intact.
			`--label ${DOCKER_LABELS.tunnelOnly}=true \\`;
}

/**
 * Converge Traefik: rewrite configs every run, recreate the container only
 * when the image or static config changed (or it is not running).
 */
export async function setupTraefik(
	executor: Executor,
	acmeEmail: string,
	onLog?: SetupLogCallback,
	/**
	 * false: a tunnel-only server. Traefik publishes no host ports; the
	 * Cloudflare Tunnel connector reaches it on nitrobase-network.
	 */
	publishPorts = true,
	/** This panel's instance id: Traefik is labelled with its owner. */
	instanceId?: string,
): Promise<void> {
	const config = getConfig();
	const paths = hostPaths(config);
	const version = traefikVersion(config);
	const image = q(config.TRAEFIK_IMAGE);
	const container = q(config.TRAEFIK_CONTAINER);
	const oldAcme = `${paths.traefikDynamic}/acme.json`;

	// Older bootstraps (and tunnel jobs) may not have the tunnel network yet.
	await ensureTunnelNetwork(executor, onLog);
	onLog?.event("setup.traefik_dirs");
	const dirs = await executor.exec(`
		set -e
		mkdir -p ${q(paths.traefikDynamic)} ${q(paths.acmeDir)} ${q(paths.apps)} ${q(paths.logs)}
		chmod 755 ${q(paths.root)} ${q(paths.traefik)}
		chmod 700 ${q(paths.acmeDir)}
		# Migrate certificates from the old location inside the watched dynamic dir.
		if [ -s ${q(oldAcme)} ] && [ ! -s ${q(paths.acmeFile)} ]; then
			mv ${q(oldAcme)} ${q(paths.acmeFile)}
		fi
		rm -f ${q(oldAcme)}
		touch ${q(paths.acmeFile)}
		chmod 600 ${q(paths.acmeFile)}
	`);
	if (dirs.exitCode !== 0) {
		throw commandError("SETUP_TRAEFIK_DIRS_FAILED", dirs.stderr);
	}

	onLog?.event("setup.traefik_configs");
	const staticConfig = traefikStaticConfig(acmeEmail);
	await executor.upload(staticConfig, paths.traefikStatic);
	await executor.upload(traefikMiddlewaresConfig(), paths.traefikMiddlewares);

	const hash = traefikConfigHash(staticConfig, { publishPorts, instanceId });
	const current = await executor.exec(
		`docker inspect -f '{{.State.Running}} ${labelValueTemplate("configHash")}' ${container} 2>/dev/null`,
	);
	if (current.exitCode === 0 && current.stdout === `true ${hash}`) {
		onLog?.event("setup.traefik_current", { version });
		return;
	}

	// Pull before touching the running proxy so a registry failure can't
	// take every app offline.
	onLog?.event("setup.traefik_pulling", { image: config.TRAEFIK_IMAGE });
	const pull = await executor.exec(`docker pull -q ${image}`);
	if (pull.exitCode !== 0) {
		throw new AppError("SETUP_TRAEFIK_PULL_FAILED", {
			image: config.TRAEFIK_IMAGE,
			detail: pull.stderr,
		});
	}

	onLog?.event("setup.traefik_starting", {
		container: config.TRAEFIK_CONTAINER,
		image: config.TRAEFIK_IMAGE,
	});
	const runResult = await executor.exec(`
		set -e
		docker rm -f ${container} 2>/dev/null || true
		docker create \\
			--name ${container} \\
			--restart always \\
			--network ${q(config.NITROBASE_NETWORK)} \\
			--label ${DOCKER_LABELS.configHash}=${hash} \\
			${instanceId ? `--label ${OWNER_LABEL}=${q(instanceId)} \\` : "\\"}
			${traefikPortFlags(publishPorts)}
			-v ${q(`${paths.traefikStatic}:/etc/traefik/traefik.yml:ro`)} \\
			-v ${q(`${paths.traefikDynamic}:${paths.traefikDynamic}:ro`)} \\
			-v ${q(`${paths.acmeDir}:${paths.acmeDir}`)} \\
			${image} >/dev/null
		# The tunnel entrypoint binds this address: attach before starting.
		docker network connect --ip ${q(config.TRAEFIK_TUNNEL_IP)} ${q(config.TUNNEL_NETWORK)} ${container}
		docker start ${container} >/dev/null
	`);
	if (runResult.exitCode !== 0) {
		throw commandError("SETUP_TRAEFIK_START_FAILED", runResult.stderr);
	}
	// A recreated Traefik must rejoin the private panel network (if the
	// panel domain was set up), or the panel route stops working.
	const panelNet = q(config.PANEL_NETWORK);
	await executor.exec(
		`docker network inspect ${panelNet} >/dev/null 2>&1 && docker network connect ${panelNet} ${container} 2>/dev/null || true`,
	);
	onLog?.event(
		publishPorts ? "setup.traefik_running" : "setup.traefik_running_tunnel",
		{ version },
	);
}

/**
 * Append a public key to the login user's authorized_keys. Idempotent.
 */
export async function installManagedKey(
	executor: Executor,
	publicKey: string,
): Promise<void> {
	const script = `
		set -e
		mkdir -p ~/.ssh
		chmod 700 ~/.ssh
		touch ~/.ssh/authorized_keys
		[ -z "$(tail -c1 ~/.ssh/authorized_keys)" ] || echo >> ~/.ssh/authorized_keys
		key=$(cat)
		grep -qxF "$key" ~/.ssh/authorized_keys || printf '%s\\n' "$key" >> ~/.ssh/authorized_keys
		chmod 600 ~/.ssh/authorized_keys
	`;

	const result = await executor.exec(script, { input: publicKey.trim() });
	if (result.exitCode !== 0) {
		throw commandError("SETUP_KEY_INSTALL_FAILED", result.stderr);
	}
}

/**
 * Full bootstrap flow, shared by remote and local servers.
 * Idempotent and safe to rerun: every step converges.
 */
export async function bootstrapServer(
	executor: Executor,
	acmeEmail: string,
	onLog?: SetupLogCallback,
	control: {
		/** Cancel: checked between steps. */
		signal?: AbortSignal;
		/** Runs a step a cancel must not interrupt (the Traefik swap). */
		critical?: <T>(label: JobStep, step: () => Promise<T>) => Promise<T>;
		/** Tunnel-only server: ports 80/443 are neither needed nor published. */
		tunnelOnly?: boolean;
		/**
		 * Ownership: this panel's id, the folders of its apps on this server
		 * (marked as ours), and whether an instance admin chose to take the
		 * server over from another instance.
		 */
		owner?: { instanceId: string; appFolders: string[]; takeover?: boolean };
	} = {},
): Promise<BootstrapResult> {
	const steps: JobLogEvent[] = [];
	// Everything before installBasePackages only reads the server.
	let changed = false;
	const checkpoint = () => {
		if (control.signal?.aborted) throw new AppError("JOB_CANCELLED");
	};
	const critical =
		control.critical ??
		(<T>(_label: JobStep, step: () => Promise<T>) => step());
	const emit = <E extends JobLogEvent>(code: E, ...params: JobLogArgs<E>) => {
		steps.push(code);
		onLog?.event(code, ...params);
	};

	try {
		emit("setup.gathering");
		const systemInfo = await gatherSystemInfo(executor, onLog);
		if (control.owner) {
			const ownership = await probeServerOwnership(
				executor,
				control.owner.instanceId,
			);
			assertServerUsable(ownership, { takeover: control.owner.takeover });
			if (ownership.foreign.length) {
				emit("setup.takeover", { owners: { $list: ownership.foreign } });
			}
		}

		if (control.tunnelOnly) {
			emit("setup.tunnel_only");
		} else if (systemInfo.traefikContainer) {
			emit("setup.traefik_existing");
		} else if (
			!systemInfo.portsAvailable.port80 ||
			!systemInfo.portsAvailable.port443
		) {
			throw new AppError("SETUP_PORTS_BUSY");
		} else {
			emit("setup.ports_ok");
		}

		checkpoint();
		changed = true;
		await installBasePackages(executor, systemInfo.family, onLog);
		checkpoint();

		let dockerVersion = systemInfo.dockerVersion;
		if (!systemInfo.dockerInstalled) {
			emit("setup.docker_engine_installing");
			const docker = await installDocker(executor, systemInfo.family, onLog);
			dockerVersion = docker.version;
			emit("setup.docker_engine_installed", { version: docker.version ?? "?" });
		} else {
			emit("setup.docker_engine_present", { version: dockerVersion ?? "?" });
		}

		checkpoint();
		await ensureSharedNetwork(executor, onLog);
		checkpoint();

		if (control.owner) {
			// Claim the managed dirs and adopt this panel's existing app folders.
			const paths = hostPaths();
			// The managed root may not exist yet on a fresh server.
			await executor.exec(`mkdir -p ${q(paths.root)}`);
			const claim = await executor.exec(
				claimServerScript(
					paths.root,
					paths.apps,
					control.owner.appFolders,
					control.owner.instanceId,
				),
			);
			if (claim.exitCode !== 0) {
				throw commandError("SETUP_CLAIM_FAILED", claim.stderr);
			}
		}
		emit("setup.traefik_setup");
		// rm + run of the proxy container: never leave the server without it.
		await critical("traefik_swap", () =>
			setupTraefik(
				executor,
				acmeEmail,
				onLog,
				!control.tunnelOnly,
				control.owner?.instanceId,
			),
		);
		emit("setup.done");

		return {
			success: true,
			steps,
			error: null,
			os: systemInfo.os,
			dockerVersion,
			changed,
		};
	} catch (error) {
		onLog?.event("job.error", { error: { $error: errorInfoOf(error) } });
		return {
			success: false,
			steps,
			error,
			os: null,
			dockerVersion: null,
			changed,
			foreignOwner:
				error instanceof ServerManagedElsewhereError ? error.owner : undefined,
		};
	}
}

/** Bootstrap refused: another Nitrobase instance manages the server. */
export class ServerManagedElsewhereError extends AppError<"SERVER_MANAGED_ELSEWHERE"> {
	constructor(readonly owner: string) {
		super("SERVER_MANAGED_ELSEWHERE", { owner });
		this.name = "ServerManagedElsewhereError";
	}
}

/**
 * Throw when the panel may not write to the server: another instance
 * manages it (unless `takeover`).
 */
export function assertServerUsable(
	ownership: ServerOwnership,
	options: { takeover?: boolean } = {},
): void {
	if (ownership.foreign.length && !options.takeover) {
		throw new ServerManagedElsewhereError(ownership.foreign[0]);
	}
}

/**
 * Refuse to act on a server another Nitrobase instance manages (deploys,
 * routes, backups, file refreshes): its Traefik and folders are not ours
 * to write.
 */
export async function assertServerOwned(
	executor: Executor,
	instanceId: string,
): Promise<void> {
	assertServerUsable(await probeServerOwnership(executor, instanceId));
}

/** Who manages the server's Nitrobase root and Traefik (see ownership.ts). */
export async function probeServerOwnership(
	executor: Executor,
	instanceId: string,
): Promise<ServerOwnership> {
	const config = getConfig();
	const result = await executor.exec(
		serverOwnershipScript(hostPaths(config).root, config.TRAEFIK_CONTAINER),
	);
	return evaluateServerOwnership(parseKeyValueLines(result.stdout), instanceId);
}
