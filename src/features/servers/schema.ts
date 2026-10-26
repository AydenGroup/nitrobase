import type { I18n } from "@lingui/core";
import { z } from "zod";
import { SERVER_AUTH_METHODS } from "#/config/ssh-key-types.ts";
import type {
	deploymentStatusEnum,
	deployments,
	serverStatusEnum,
	servers,
} from "#/db/schema/server";
import type {
	MonitoringSnapshot,
	ServerHealthSummary,
} from "#/features/monitoring/schema.ts";
import type { ErrorInfo } from "#/libs/coded.ts";
import { isServerHost } from "#/libs/host.ts";

/** State of a server's Cloudflare Tunnel connector. */
export type TunnelState =
	| "connected"
	| "connecting"
	| "failing"
	| "stopped"
	| "not_configured";
export type ServerStatus = (typeof serverStatusEnum.enumValues)[number];
export type DeploymentStatus = (typeof deploymentStatusEnum.enumValues)[number];

/** SSH host: IP address or hostname, trimmed. */
const serverHost = (i18n: I18n) =>
	z
		.string()
		.trim()
		.min(1, { message: i18n._("Host is required") })
		.refine(isServerHost, {
			message: i18n._("Enter an IP address or a hostname"),
		});

/**
 * New server form/RPC input (localized messages via `i18n`). The credential
 * required depends on `authMethod`: a saved key id or a password.
 */
export const AddServerSchema = (i18n: I18n) =>
	z
		.object({
			name: z.string().min(1, { message: i18n._("Server name is required") }),
			host: serverHost(i18n),
			port: z
				.number()
				.int()
				.min(1, { message: i18n._("Port must be at least 1") })
				.max(65535, { message: i18n._("Port must be at most 65535") }),
			username: z.string().min(1, { message: i18n._("Username is required") }),
			authMethod: z.enum(SERVER_AUTH_METHODS),
			sshKeyId: z.string().uuid().optional(),
			password: z.string().optional(),
		})
		.superRefine((data, ctx) => {
			if (data.authMethod === "private_key" && !data.sshKeyId) {
				ctx.addIssue({
					code: "custom",
					message: i18n._("SSH key is required"),
					path: ["sshKeyId"],
				});
			}
			if (data.authMethod === "password" && !data.password) {
				ctx.addIssue({
					code: "custom",
					message: i18n._("Password is required"),
					path: ["password"],
				});
			}
		});

/**
 * Partial server update: every field but `id` is optional and omitted
 * fields stay unchanged. `sshKeyId: null` explicitly clears the key.
 */
export const UpdateServerSchema = (i18n: I18n) =>
	z
		.object({
			id: z.uuid({ message: i18n._("Server ID is required") }),
			name: z
				.string()
				.min(1, { message: i18n._("Server name is required") })
				.optional(),
			host: serverHost(i18n).optional(),
			port: z
				.number()
				.int()
				.min(1, { message: i18n._("Port must be at least 1") })
				.max(65535, { message: i18n._("Port must be at most 65535") })
				.optional(),
			username: z
				.string()
				.min(1, { message: i18n._("Username is required") })
				.optional(),
			authMethod: z.enum(SERVER_AUTH_METHODS).optional(),
			sshKeyId: z.string().uuid().nullish(),
			password: z.string().optional(),
		})
		.superRefine((data, ctx) => {
			// A blank password keeps the stored one (checked server-side).
			if (data.authMethod === "private_key" && data.sshKeyId === null) {
				ctx.addIssue({
					code: "custom",
					message: i18n._("SSH key is required"),
					path: ["sshKeyId"],
				});
			}
		});

export const TestServerCredentialsSchema = z.object({
	id: z.guid().optional(),
	host: z.string().trim().min(1).refine(isServerHost).optional(),
	port: z.number().int().min(1).max(65535).optional(),
	username: z.string().min(1).optional(),
	authMethod: z.enum(SERVER_AUTH_METHODS).optional(),
	sshKeyId: z.string().uuid().nullish(),
	password: z.string().optional(),
});

export const StartServerActionSchema = z.object({
	serverId: z.guid(),
	action: z.enum(["bootstrap", "connection_test"]),
	/** Bootstrap a server another Nitrobase instance manages (instance admins). */
	takeover: z.boolean().optional(),
});

export type StartServerActionInput = z.infer<typeof StartServerActionSchema>;

export type ServerInput = z.infer<ReturnType<typeof AddServerSchema>>;
export type ServerUpdateInput = Omit<
	z.infer<ReturnType<typeof UpdateServerSchema>>,
	"id"
>;

export type TestServerCredentialsInput = z.infer<
	typeof TestServerCredentialsSchema
>;

export type ServerRow = typeof servers.$inferSelect;
type DeploymentRow = typeof deployments.$inferSelect;
export type ServerDTO = Omit<
	ServerRow,
	"passwordEncrypted" | "tunnelTokenEncrypted"
> & {
	/** A Cloudflare Tunnel token is stored (the token never leaves the server). */
	tunnelConfigured: boolean;
};
/** Live facts of a server for the server list (not part of the DTO). */
export interface ServerSummary {
	serverId: string;
	appCount: number;
	databaseCount: number;
	health: ServerHealthSummary | null;
}

export interface ServerSummaries {
	servers: ServerSummary[];
	/** Config: alert thresholds the usage bars turn warning at. */
	thresholds: MonitoringSnapshot["thresholds"];
}

export type DeploymentDTO = Omit<
	DeploymentRow,
	"stoppedServices" | "workDir" | "cancelRequestedAt" | "rollback"
>;

export const ServerTunnelSchema = z.object({
	serverId: z.guid(),
	/** New connector token; empty keeps the stored one. */
	token: z.string().trim().max(4096).optional(),
	enabled: z.boolean(),
	tunnelOnly: z.boolean().default(false),
});

/** Server resource policy (M6, Settings → Resource limits). */
export const ServerResourcePolicySchema = z.object({
	serverId: z.guid(),
	requireLimits: z.boolean(),
	/** Memory limit (MiB) for services that have none; null = refuse instead. */
	defaultMemoryMb: z.number().int().min(16).max(1_048_576).nullable(),
});
export type ServerResourcePolicyInput = z.infer<
	typeof ServerResourcePolicySchema
>;

/** What a bootstrap would change on a server (confirmation dialog). */
export interface BootstrapPreview {
	reachable: boolean;
	/** Connection/probe failure (the dialog still lists the changes). */
	error: ErrorInfo | null;
	/** Password login is replaced by a Nitrobase-managed key. */
	managedKey: boolean;
	tunnelOnly: boolean;
	dockerVersion: string | null;
	dockerInstalled: boolean | null;
	traefikExists: boolean | null;
	/** 80/443 already used by something other than Nitrobase's Traefik. */
	portsBusy: number[];
	/** Instance id of another Nitrobase managing the server. */
	foreignOwner: string | null;
	/** The viewer may take the server over (instance administrators). */
	canTakeOver: boolean;
	/**
	 * A Traefik without an owner mark, on a server this database has no
	 * apps on: possibly another (older) panel's.
	 */
	unclaimedTraefik: boolean;
	/** apt packages bootstrap installs when missing. */
	packages: string[];
	networks: string[];
	traefikContainer: string;
	root: string;
}

/** Typed confirmation for wiping orphaned data with no recorded owner. */
export function unknownWipePhrase(folder: string): string {
	return `wipe ${folder}`;
}
