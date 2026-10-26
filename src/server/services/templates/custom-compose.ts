import { parse as parseYaml } from "yaml";
import type { RestartPolicy } from "#/config/restart-policies.ts";
import type { CustomComposeAnalysis } from "#/features/templates/schema.ts";
import type { ErrorInfo } from "#/libs/coded.ts";
import { coded } from "#/utils/error.ts";
import { fileBindSources } from "./bind-sources";
import { assertNoMergeKeys, isObj } from "./compose-policy";
import { transformCompose } from "./compose-transform";
import { TemplateError } from "./naming";
import { parseEnvFile } from "./variables";

/**
 * What a pasted compose file offers (custom compose wizard): services with
 * the container ports they declare, named volumes, env names it reads, and
 * the policy verdict. Pure; the full transform runs again at deploy time
 * with the chosen routes.
 */
export type { CustomComposeAnalysis };

type Obj = Record<string, unknown>;

/** Container ports from `ports` (target side) and `expose`. */
function containerPorts(service: Obj): number[] {
	const ports = new Set<number>();
	const add = (value: unknown) => {
		const port = Number(value);
		if (Number.isInteger(port) && port > 0 && port < 65536) ports.add(port);
	};
	for (const entry of Array.isArray(service.ports) ? service.ports : []) {
		if (isObj(entry)) add(entry.target);
		else {
			// "8080:80", "127.0.0.1:8080:80/tcp", "80"
			const spec = String(entry).split("/")[0];
			add(spec.split(":").at(-1)?.split("-")[0]);
		}
	}
	for (const entry of Array.isArray(service.expose) ? service.expose : []) {
		add(String(entry).split("/")[0].split("-")[0]);
	}
	return [...ports].sort((a, b) => a - b);
}

export function analyzeCustomCompose(
	compose: string,
	env: string,
	ctx: {
		appRoot: string;
		folder: string;
		network: string;
		/** Same default restart policy as a deploy (`APP_DEFAULT_RESTART`). */
		defaultRestart?: RestartPolicy;
	},
): CustomComposeAnalysis {
	let parsed: unknown;
	try {
		parsed = parseYaml(compose, { merge: true, maxAliasCount: 100 });
		assertNoMergeKeys(parsed);
	} catch (error) {
		return {
			services: [],
			volumes: [],
			fileBinds: [],
			missingEnv: [],
			error:
				error instanceof TemplateError
					? coded(error.code, error.params as never)
					: coded("COMPOSE_YAML_INVALID", {
							detail: error instanceof Error ? error.message : String(error),
						}),
			warnings: [],
		};
	}
	if (!isObj(parsed) || !isObj(parsed.services)) {
		return {
			services: [],
			volumes: [],
			fileBinds: [],
			missingEnv: [],
			error: coded("COMPOSE_NO_SERVICES"),
			warnings: [],
		};
	}
	const services = Object.entries(parsed.services).map(([name, raw]) => {
		const service = isObj(raw) ? raw : {};
		return {
			name,
			image: typeof service.image === "string" ? service.image : null,
			ports: containerPorts(service),
		};
	});
	const volumes = isObj(parsed.volumes) ? Object.keys(parsed.volumes) : [];
	const defined = parseEnvFile(env);
	const missing = new Set<string>();
	for (const match of compose
		.replace(/\$\$/g, "")
		.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(:?[-?+][^}]*)?\}/g)) {
		const hasDefault = !!match[2] && /^:?[-+]/.test(match[2]);
		if (!hasDefault && !(match[1] in defined)) missing.add(match[1]);
	}
	let error: ErrorInfo | null = null;
	let warnings: ErrorInfo[] = [];
	let fileBinds: string[] = [];
	try {
		const transformed = transformCompose(parsed, {
			appId: "00000000-0000-4000-8000-000000000000",
			folder: ctx.folder,
			appRoot: ctx.appRoot,
			network: ctx.network,
			proxiedServices: [],
			defaultRestart: ctx.defaultRestart
				? { policy: ctx.defaultRestart }
				: undefined,
		});
		warnings = transformed.warnings;
		// What the deploy will add, so the owner can opt a job out.
		if (ctx.defaultRestart && transformed.restartDefaulted.length > 0) {
			warnings.push(
				coded("COMPOSE_WARN_RESTART_DEFAULT", {
					services: { $list: transformed.restartDefaulted },
					policy: ctx.defaultRestart,
				}),
			);
		}
		// Nothing is written for a custom compose: every file-named bind
		// source must be put on the server, or be created by the app.
		fileBinds = [
			...new Set(
				fileBindSources({
					composeModel: transformed.compose,
					appRoot: ctx.appRoot,
					files: [],
					dataPaths: [],
				}).named.map((bind) => bind.path),
			),
		];
	} catch (failure) {
		if (!(failure instanceof TemplateError)) throw failure;
		error = coded(failure.code, failure.params as never);
	}
	return {
		services,
		volumes,
		fileBinds,
		missingEnv: [...missing].sort(),
		error,
		warnings,
	};
}
