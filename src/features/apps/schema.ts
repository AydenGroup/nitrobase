import type { I18n } from "@lingui/core";
import { z } from "zod";
import type { AppSourceKind } from "#/config/app-sources.ts";
import type { CheckDetail } from "#/config/check-details.ts";
import { DATABASE_ENGINE_IDS } from "#/config/database-engines.ts";
import type { Permission } from "#/config/permissions.ts";
import type { PreflightCheckId } from "#/config/preflight.ts";
import { NAME_MAX_LENGTH } from "#/config/shared.ts";
import type {
	appStatusEnum,
	apps,
	DomainCheckStatusValue,
	domains,
} from "#/db/schema/apps";
import { GitAppSpecSchema } from "#/features/git/schema.ts";
import {
	CUSTOM_COMPOSE_MAX_BYTES,
	CUSTOM_ENV_MAX_BYTES,
	CustomComposeSpecSchema,
	type ExtraDomainRule,
	type TemplateRotateHook,
} from "#/features/templates/schema.ts";
import type { ErrorInfo } from "#/libs/coded.ts";
import { ENV_NAME_PATTERN, SLUG_PATTERN } from "#/libs/naming-rules.ts";
import type { DowngradeRisk } from "#/server/services/app-updates/policy.ts";

export type AppStatus = (typeof appStatusEnum.enumValues)[number];
export type DomainCheckStatus = DomainCheckStatusValue;
export type AppRow = typeof apps.$inferSelect;
export type DomainRow = typeof domains.$inferSelect;
export type AppDTO = Omit<
	AppRow,
	| "envEncrypted"
	| "envDeployedEncrypted"
	| "serviceEnvEncrypted"
	| "customSpecEncrypted"
	| "composeDeployed"
	| "inputs"
>;
type DomainDTO = DomainRow;

const versionRef = z
	.string()
	.min(1)
	.max(200)
	.regex(/^[\w][\w./@-]*$/);
const serviceName = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);

export const CreateAppSchema = (i18n: I18n) =>
	z.object({
		templateId: z.string().regex(SLUG_PATTERN),
		serverId: z.uuid({ message: i18n._("Select a server") }),
		name: z
			.string()
			.trim()
			.min(1, { message: i18n._("App name is required") })
			.max(NAME_MAX_LENGTH),
		version: versionRef.optional(),
		/** Empty: a free domain (e.g. sslip.io) is generated. */
		domain: z.string().trim().max(253).optional(),
		inputs: z
			.record(z.string().regex(ENV_NAME_PATTERN), z.string())
			.default({}),
		/** Custom compose templates: the owner's compose, env and choices. */
		custom: CustomComposeSpecSchema.optional(),
		/** Git templates: repository, build and runtime settings. */
		git: GitAppSpecSchema.optional(),
		/** Database template: engine and pinned image tag. */
		database: z
			.object({
				engine: z.enum(DATABASE_ENGINE_IDS),
				version: z.string().regex(/^[0-9][A-Za-z0-9._-]{0,63}$/),
			})
			.optional(),
		/** The UI showed the template's security/advanced warnings. */
		acknowledged: z.boolean().default(false),
	});

export type CreateAppInput = z.infer<ReturnType<typeof CreateAppSchema>>;

export const AppIdSchema = z.guid();

export const AppActionSchema = z.discriminatedUnion("action", [
	z.object({ appId: z.guid(), action: z.literal("redeploy") }),
	z.object({ appId: z.guid(), action: z.literal("routes") }),
	z.object({
		appId: z.guid(),
		action: z.enum(["start", "stop", "restart"]),
		service: serviceName.optional(),
	}),
	z.object({
		appId: z.guid(),
		action: z.literal("update"),
		version: versionRef,
		/** Run a full backup (policy destination) before updating. */
		backupFirst: z.boolean().default(false),
		/**
		 * Required when `version` is older than what runs (the preview's
		 * `downgrade`): the server refuses an unconfirmed downgrade.
		 */
		confirmDowngrade: z.boolean().default(false),
	}),
]);

export const MoveAppSchema = z.object({
	appId: z.guid(),
	targetServerId: z.guid(),
	/** S3/R2/B2 destination both servers reach (the archive travels through it). */
	destinationId: z.guid(),
});

export const PreviewAppUpdateSchema = z.object({
	appId: z.guid(),
	version: versionRef,
});

export const DeleteAppSchema = z.object({
	appId: z.guid(),
	/** The app's folder (slug), typed by the user. */
	confirmName: z.string(),
	wipeData: z.boolean().default(false),
	/** Also remove images no other container uses. */
	removeImages: z.boolean().default(false),
	/** Run a full backup (policy destination) before deleting. */
	backupFirst: z.boolean().default(false),
});

/** Largest env editor text (`KEY=value` lines) and single service env value. */
const APP_ENV_MAX_LENGTH = 200_000;
const ENV_VALUE_MAX_LENGTH = 10_000;

/** Most variables one env save may name (per kind of change). */
const APP_ENV_MAX_EDITS = 500;

const envNames = z
	.array(z.string().regex(ENV_NAME_PATTERN))
	.max(APP_ENV_MAX_EDITS)
	.default([]);

/**
 * One env editor save: only the variables that changed (values not named
 * are kept as stored), against the env `version` the editor loaded.
 */
export const UpdateAppEnvSchema = z.object({
	appId: z.guid(),
	/** New or edited values. */
	set: z
		.record(z.string().regex(ENV_NAME_PATTERN), z.string())
		.default({})
		.refine(
			(set) =>
				Object.keys(set).length <= APP_ENV_MAX_EDITS &&
				Object.entries(set).reduce(
					(total, [name, value]) => total + name.length + value.length,
					0,
				) <= APP_ENV_MAX_LENGTH,
		),
	/** Custom variables to delete. */
	remove: envNames,
	/** Template variables handed back to the template (drop overrides). */
	reset: envNames,
	/** `AppEnvView.version` the edits are based on. */
	version: z.string().min(1).max(128),
});

export type AppEnvEdit = Omit<z.infer<typeof UpdateAppEnvSchema>, "appId">;

export const RevealCredentialSchema = z.object({
	appId: z.guid(),
	name: z.string().regex(ENV_NAME_PATTERN),
});

export const AddDomainSchema = (i18n: I18n) =>
	z.object({
		appId: z.guid(),
		host: z
			.string()
			.trim()
			.min(1, { message: i18n._("Domain is required") })
			.max(253),
		service: serviceName,
		port: z.number().int().min(1).max(65535),
		https: z.boolean().default(true),
		/** Serve it through the server's Cloudflare Tunnel. */
		viaTunnel: z.boolean().default(false),
	});

export type AddDomainInput = z.infer<ReturnType<typeof AddDomainSchema>>;

export const RotateVariableSchema = z.object({
	appId: z.guid(),
	name: z.string().regex(ENV_NAME_PATTERN),
	backupFirst: z.boolean().default(false),
	/**
	 * Run the variable's template `on_rotate` step after the redeploy
	 * (e.g. sign every user out); omitted: the template's default.
	 */
	runRotateHook: z.boolean().optional(),
});

/** Run a failed `on_rotate` step again (no rotation). */
export const RerunRotateHookSchema = z.object({
	appId: z.guid(),
	name: z.string().regex(ENV_NAME_PATTERN),
});

export const SetPublishedPortsSchema = z.object({
	appId: z.guid(),
	/** Template port id -> host port, or null to stop publishing it. */
	ports: z.record(
		z.string().regex(SLUG_PATTERN),
		z.number().int().min(1024).max(65535).nullable(),
	),
	/** Port ids to bind on 127.0.0.1 only (others: every interface). */
	loopback: z.array(z.string().regex(SLUG_PATTERN)).optional(),
	/** The UI shows the exposure warning; the server insists it was confirmed. */
	acknowledged: z.literal(true),
});

export const ServiceEnvQuerySchema = z.object({
	appId: z.guid(),
	service: serviceName,
});

export const UpdateServiceEnvSchema = z.object({
	appId: z.guid(),
	service: serviceName,
	set: z
		.record(
			z.string().regex(ENV_NAME_PATTERN),
			z.string().max(ENV_VALUE_MAX_LENGTH),
		)
		.default({}),
	remove: z.array(z.string().regex(ENV_NAME_PATTERN)).default([]),
});

/** Secret env of one service: names only, values are never returned. */
export interface ServiceEnvView {
	names: string[];
	/** False until a redeploy makes the service read its env file. */
	applied: boolean;
}

export const DomainIdSchema = z.object({ appId: z.guid(), domainId: z.guid() });

/** One variable of the env editor (no value: values are in `text`). */
export interface AppEnvVariable {
	name: string;
	/** Set by the template (manifest or upstream defaults): can't be removed. */
	template: boolean;
	/** Masked in `text` until an audited reveal. */
	secret: boolean;
	/** Template texts (English; translated with `translateTemplateText`). */
	label?: string;
	description?: string;
	/** Template section heading (e.g. "Email"); none: "General". */
	group?: string;
	/** The template generates the value (secrets, keys). */
	generated: boolean;
	/** Can be regenerated with the rotate job. */
	rotatable: boolean;
	/** Template step offered in the rotate dialog (null: none). */
	rotateHook: RotateHookView | null;
	/**
	 * Template-managed (not editable at deploy time), or an `initial_only`
	 * value the app has already read: read-only in the form.
	 */
	locked: boolean;
	/**
	 * Template `initial_only`: only read on the app's first start, which is
	 * still ahead (`first_start`) or behind it (`applied`: frozen), or it
	 * was added after that start (`not_applied`: the app never read it).
	 */
	initialOnly?: "first_start" | "applied" | "not_applied";
	/** Team permission needed (besides app.env.edit) to change it. */
	permission?: Permission;
	/** The owner set this template variable's value (can be reset). */
	overridden: boolean;
}

export interface AppEnvView {
	/** `.env` text, secret values masked. */
	text: string;
	/** Template variables in template order, then the others. */
	variables: AppEnvVariable[];
	needsRedeploy: boolean;
	/** Opaque version of the stored env: a save based on another is refused. */
	version: string;
}

export interface AppCredential {
	name: string;
	/** Human label (template text), e.g. "Admin email". */
	label?: string;
	description?: string;
	secret: boolean;
	/** Can be regenerated from the app page (redeploy job). */
	rotatable: boolean;
	rotateHook: RotateHookView | null;
	/**
	 * The initial value of an `initial_only` variable the app has already
	 * read: the app may have changed it since (e.g. a password changed in
	 * its own dashboard).
	 */
	initial: boolean;
	/** Masked when `secret`. */
	value: string;
}

/**
 * The template's `on_rotate` step as the rotate dialog shows it (template
 * texts, English; translated with `translateTemplateText`). No SQL.
 */
export interface RotateHookView {
	label: string;
	/** What running the step does / what happens without it. */
	description: string | null;
	skipped: string | null;
	/** Ticked by default. */
	default: boolean;
}

/** Dialog view of a variable's `on_rotate` step (null: none). */
export function rotateHookView(
	hook: TemplateRotateHook | undefined,
): RotateHookView | null {
	return hook
		? {
				label: hook.label,
				description: hook.description ?? null,
				skipped: hook.skipped ?? null,
				default: hook.default,
			}
		: null;
}

/** Template port the owner may publish on the host (null = not published). */
export interface AppPortView {
	id: string;
	service: string;
	port: number;
	label: string;
	description?: string;
	defaultHostPort: number | null;
	hostPort: number | null;
	/** Bound on 127.0.0.1 only (reach it through an SSH tunnel). */
	loopback: boolean;
}

export interface AppOverview {
	app: AppDTO;
	/**
	 * Its deployed compose still names a shared network (deployed before
	 * BUG-006 was fixed, files not rewritten): redeploy to finish the fix.
	 */
	networkFixPending: boolean;
	/**
	 * A job holds the app when the overview was read (backup, move, service
	 * restart...): another job would be refused.
	 */
	jobRunning: boolean;
	/**
	 * Services the deployed compose file leaves without the default restart
	 * policy (deployed before it existed): applied by the next redeploy.
	 */
	restartPolicyPending: string[];
	/**
	 * Rotated variables whose template `on_rotate` step failed or could not
	 * run (`label`: template text): the overview offers to run it again.
	 */
	rotateHooksFailed: { name: string; label: string }[];
	ports: AppPortView[];
	server: {
		id: string;
		name: string;
		host: string;
		/** Cloudflare Tunnel configured / every domain through it. */
		tunnelEnabled: boolean;
		tunnelOnly: boolean;
		/** Service URL tunnel hostnames point at in Cloudflare. */
		tunnelService: string;
		/** Public IPs custom domains should point at (A/AAAA records). */
		ips: string[];
	};
	domains: DomainDTO[];
	/**
	 * Services and ports where an additional domain is limited or refused
	 * (template `[[domains]] extra_domains`; `reason` is template text).
	 */
	extraDomainRules: ExtraDomainRule[];
	services: string[];
	credentials: AppCredential[];
	/** The template declares credential variables (else the panel is hidden). */
	hasCredentials: boolean;
	/** Template display name (template text). */
	templateName: string;
	primaryUrl: string | null;
	/**
	 * Template texts below are English (template.toml); the UI translates
	 * them with `translateTemplateText`.
	 */
	/** Template after-deploy notes. */
	notes: string | null;
	/** Template limitation label. */
	limitation: string | null;
	/** Custom compose app (compose editable from the app page). */
	customCompose: boolean;
	/** Where the app comes from (#/config/app-sources.ts). */
	sourceKind: AppSourceKind;
	/**
	 * Quick links (template `[[links]]`); `label` is template text, ""
	 * for the default "Open app" link.
	 */
	links: { label: string; url: string; primary: boolean }[];
	/** Effective resource limits per service (M6). */
	resources: AppServiceResources[];
	/** Latest monitoring sample of the app's containers. */
	usage: {
		at: Date;
		cpuPercent: number;
		memUsed: number;
		/**
		 * Every deployed service has a recent sample that is running and not
		 * unhealthy or still starting (a failed readiness wait may have
		 * recovered; see `allServicesHealthy`).
		 */
		allHealthy: boolean;
		/**
		 * Long-running services without a running container (stopped,
		 * restarting, gone): the app shows as partially running.
		 */
		notRunning: string[];
		/**
		 * Expected services with no container at all (not profile-gated,
		 * not scaled to 0): only a redeploy creates them.
		 */
		missing: string[];
		services: {
			service: string;
			cpuPercent: number | null;
			memUsed: number | null;
			memLimit: number | null;
		}[];
	} | null;
}

export interface AppServiceResources {
	service: string;
	memoryMb: number | null;
	memoryReservationMb: number | null;
	cpus: number | null;
	/** Template defaults (null = none). */
	templateMemoryMb: number | null;
	templateCpus: number | null;
	/** The app overrides the template for this service. */
	overridden: boolean;
}

export interface AppUpdatePreview {
	version: string;
	commitSha: string;
	composeDiff: string;
	composeChanged: boolean;
	env: { added: string[]; removed: string[]; changed: string[] };
	/**
	 * The version is older than what runs (null: not a downgrade, or the
	 * versions do not compare): applying it needs `confirmDowngrade`.
	 */
	downgrade: DowngradeRisk | null;
	warnings: ErrorInfo[];
}

export const PreflightInputSchema = z.object({
	templateId: z.string().regex(SLUG_PATTERN),
	serverId: z.guid(),
	domain: z.string().trim().max(253).optional(),
	/**
	 * The wizard's choices: the template is dry-rendered with them (no
	 * server writes), so a version the policy refuses shows before deploy.
	 */
	version: versionRef.optional(),
	name: z.string().trim().max(NAME_MAX_LENGTH).optional(),
	inputs: z.record(z.string().regex(ENV_NAME_PATTERN), z.string()).default({}),
});

export interface PreflightCheck {
	/** Key into the pre-flight label registry (#/config/preflight.ts). */
	id: PreflightCheckId;
	status: "ok" | "warning" | "error";
	/** Rendered client-side in the viewer's locale (#/config/check-details.ts). */
	message: CheckDetail;
}

export interface PreflightResult {
	/** False when any check is an error (deploy is blocked). */
	ok: boolean;
	checks: PreflightCheck[];
}

export const AnalyzeComposeSchema = z.object({
	templateId: z.string().regex(SLUG_PATTERN),
	compose: z.string().min(1).max(CUSTOM_COMPOSE_MAX_BYTES),
	env: z.string().max(CUSTOM_ENV_MAX_BYTES).default(""),
});

export const CustomComposeUpdateSchema = z.object({
	appId: z.guid(),
	spec: CustomComposeSpecSchema,
	redeploy: z.boolean().default(false),
});

export const CustomComposePreviewSchema = z.object({
	appId: z.guid(),
	spec: CustomComposeSpecSchema,
});

const resourceLimit = (max: number, min: number) =>
	z.number().min(min).max(max).nullable().optional();

/** Resource limit overrides of an app (null = no Nitrobase limit). */
export const AppResourcesSchema = z.object({
	appId: z.guid(),
	resources: z.record(
		z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/),
		z
			.object({
				memoryMb: resourceLimit(1_048_576, 6),
				memoryReservationMb: resourceLimit(1_048_576, 1),
				cpus: resourceLimit(1024, 0.01),
			})
			.strict(),
	),
});
export type AppResourcesInput = z.infer<typeof AppResourcesSchema>;

export interface ResourcesPreview {
	effective: AppServiceResources[];
	overcommit: {
		memory: { limitMb: number; totalMb: number | null; over: boolean };
		cpus: { limit: number; total: number | null; over: boolean };
	};
	/** A service left without a memory limit on a server that requires one. */
	missingLimit: string | null;
}
