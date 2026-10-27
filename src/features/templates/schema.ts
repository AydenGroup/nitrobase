import { DEFAULT_THEME } from "@mantine/core";
import { z } from "zod";
import type { AppSourceKind } from "#/config/app-sources.ts";
import { FAILURE_SIGNATURE_IDS } from "#/config/failure-signatures.ts";
import { type Permission, teamPermissionIds } from "#/config/permissions.ts";
import type { ErrorInfo } from "#/libs/coded.ts";
import { ENV_NAME_PATTERN, SLUG_PATTERN } from "#/libs/naming-rules.ts";
import { ROLLBACK_MODES } from "#/server/services/app-updates/policy.ts";
import { scanSql } from "#/server/services/databases/sql.ts";
import { coded } from "#/utils/error.ts";

const relativePath = z
	.string()
	.min(1)
	.refine(
		(value) =>
			!value.startsWith("/") &&
			!value.includes("\\") &&
			!value.includes("\0") &&
			!value.split("/").includes(".."),
		"must be a relative path inside the template",
	);

const absolutePath = z
	.string()
	.regex(/^\/[^\0]*$/, "must be an absolute path")
	.refine((value) => !value.split("/").includes(".."), "must not contain ..");

/** Where a template's versions come from (`branches`: e.g. `v3.2.1` branches). */
const VERSION_SOURCES = ["tags", "releases", "commits", "branches"] as const;

/**
 * Version sources whose names are ordered releases (`1.2.3` < `1.3.0`):
 * an older target is a downgrade. Branch and commit names say nothing
 * about order.
 */
const ORDERED_VERSION_SOURCES: ReadonlySet<string> = new Set([
	"tags",
	"releases",
] satisfies (typeof VERSION_SOURCES)[number][]);

export function hasOrderedVersions(source: { versions: string }): boolean {
	return ORDERED_VERSION_SOURCES.has(source.versions);
}

/**
 * `github` (default): versions and files from a GitHub repo. `inline`: the
 * compose file is supplied per app by its owner (custom compose). `git`:
 * the owner's repository is built on the server and run from a generated
 * compose (git apps). `database`: a standalone database engine
 * (#/config/database-engines.ts). Kinds are described in
 * `#/config/app-sources.ts`.
 */
const TEMPLATE_SOURCE_TYPES = ["github", "inline", "git", "database"] as const;
export type TemplateSourceType = (typeof TEMPLATE_SOURCE_TYPES)[number];

const TemplateSourceSchema = z.object({
	type: z.enum(TEMPLATE_SOURCE_TYPES).default("github"),
	/** GitHub `owner/repo` (required for `github`). */
	repo: z
		.string()
		.regex(/^[\w.-]+\/[\w.-]+$/)
		.optional(),
	/** Where versions come from. */
	versions: z.enum(VERSION_SOURCES).default("releases"),
	/**
	 * Stripped from the version ref for `${version_number}` (e.g. `n8n@`
	 * for `n8n@1.2.3`). Only stripped when a digit follows.
	 */
	version_prefix: z.string().max(40).default("v"),
	/** Branch for `commits` mode (default: repo default branch). */
	ref: z.string().min(1).optional(),
	/**
	 * Repo directory to fetch at the chosen version (`.` = repo root; then
	 * set `include`); omit to use the template's own compose file.
	 */
	path: relativePath.optional(),
	/** Compose file name (inside `path`, or the template dir). */
	compose: relativePath.default("docker-compose.yml"),
	/** Upstream env defaults file inside `path` (e.g. `.env.example`). */
	env_defaults: relativePath.optional(),
	/**
	 * Only fetch these files/dirs (prefixes) inside `path`. Empty = all.
	 * An entry may be `{ path, min_version }`: fetched only for upstream
	 * versions >= `min_version` (a file upstream added in that release, e.g.
	 * one its compose bind-mounts from then on). Every other entry must
	 * exist at the version.
	 */
	include: z
		.array(
			z.union([
				relativePath,
				z
					.object({
						path: relativePath,
						min_version: z.string().min(1).max(100),
					})
					.strict(),
			]),
		)
		.default([]),
	/** Regex a version name must match to be offered. */
	version_filter: z.string().optional(),
	/**
	 * Oldest upstream version offered (named versions only): older ones are
	 * not listed, not picked as the default and refused at render, e.g.
	 * releases whose compose uses a setting the policy blocks.
	 */
	min_version: z.string().min(1).max(100).optional(),
	/**
	 * Version order (the first stable one is the default): `published`
	 * (as GitHub lists them) or `version` (numeric, newest first; for repos
	 * that release several major lines at once).
	 */
	sort: z.enum(["published", "version"]).default("published"),
});

/**
 * Templates hold English only. Translations live in the Lingui catalogs
 * (`src/locales/<code>.json`), filled by the template extractor
 * (`scripts/lingui/template-extractor.ts`), so adding a language never
 * touches a template. A per-locale `i18n` table is refused.
 */
/**
 * A translatable template text (its English text is the Lingui message id):
 * braces would be read as ICU placeholders, so they are refused.
 */
const templateText = () =>
	z.string().regex(/^[^{}]*$/, {
		error:
			"use plain text; ICU placeholders are not supported in template texts (no { or })",
	});

const noLocaleTexts = z
	.undefined({
		error:
			"i18n tables are not supported: write texts in English; translations go in src/locales/<locale>.json (see templates/README.md)",
	})
	.optional();

const serviceName = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
/** Postgres role / database name (same rule as the psql runner). */
const sqlRole = z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/);

/**
 * SQL without psql meta-commands, whatever the way psql is invoked: the
 * console's lexer finds no backslash outside literals and comments, and
 * every quote and comment is closed.
 */
function isPlainSql(sql: string): boolean {
	try {
		return !scanSql(sql, "postgres").backslash;
	} catch {
		return false; // unterminated quote / comment
	}
}

/**
 * A rotatable variable `name`'s value is built from, directly or through
 * other variables (the first one found), or null. Conservative: every
 * `${…}` part naming a variable counts (`${jwt:SECRET:anon}` uses SECRET).
 */
function referencedRotatable(
	variables: Record<string, { value: string; rotatable: boolean }>,
	name: string,
): string | null {
	const seen = new Set([name]);
	const queue = [name];
	while (queue.length) {
		const current = queue.shift() as string;
		for (const match of (variables[current]?.value ?? "").matchAll(
			/\$\{([^}]*)\}/g,
		)) {
			for (const part of match[1].split(":")) {
				const ref = part.trim();
				if (seen.has(ref) || !(ref in variables)) continue;
				if (variables[ref].rotatable) return ref;
				seen.add(ref);
				queue.push(ref);
			}
		}
	}
	return null;
}

/**
 * Optional step after a successful rotation of this variable (e.g. sign
 * every user out when the secret that signs their tokens changes). The
 * owner sees `label` as a checkbox in the rotate dialog, ticked when
 * `default`; `description` says what ticking it does, `skipped` what
 * happens when unticked. `sql` runs with psql as `user` on `database`
 * inside `service`'s container, only once the redeploy succeeded.
 */
const TemplateRotateHookSchema = z.object({
	label: templateText().min(1),
	description: templateText().optional(),
	skipped: templateText().optional(),
	default: z.boolean().default(true),
	service: serviceName,
	user: sqlRole,
	database: sqlRole,
	sql: z
		.string()
		.trim()
		.min(1)
		.max(4000)
		.refine(
			isPlainSql,
			"plain SQL only: no backslash outside strings or comments (psql meta-commands), complete quotes",
		),
});

export type TemplateRotateHook = z.infer<typeof TemplateRotateHookSchema>;

export const TemplateVariableSchema = z.object({
	/** Value expression, e.g. `${password:32}` or `https://${domain}`. */
	value: z.string(),
	description: templateText().optional(),
	/** Human-friendly field label for forms. */
	label: templateText().optional(),
	/** Section heading the deploy form groups this field under (e.g. "Email"). */
	group: templateText().optional(),
	i18n: noLocaleTexts,
	/** Masked everywhere; shown only through an explicit, audited reveal. */
	secret: z.boolean().default(false),
	/** Shown in the app's credentials panel (e.g. admin login). */
	credential: z.boolean().default(false),
	/** User may override the value at deploy time. */
	editable: z.boolean().default(false),
	/**
	 * Only read on the app's first start (e.g. an admin account the app
	 * creates once and then manages itself). Once the app has been deployed
	 * the value is kept as it was and can no longer be changed in the panel,
	 * which labels it as the initial value (the app may have changed it).
	 */
	initial_only: z.boolean().default(false),
	/** Validation for user-provided values. */
	type: z
		.enum(["string", "email", "url", "hostname", "integer", "boolean"])
		.default("string"),
	min_length: z.number().int().min(0).optional(),
	max_length: z.number().int().min(1).optional(),
	pattern: z.string().optional(),
	/**
	 * Generated value the owner may regenerate (rotate) from the app page.
	 * Dependents (e.g. JWTs signed with it) are regenerated too; applied by a
	 * redeploy job.
	 */
	rotatable: z.boolean().default(false),
	/** Step offered after a rotation (rotatable variables only). */
	on_rotate: TemplateRotateHookSchema.optional(),
	/**
	 * First upstream version that uses this variable: older versions render
	 * without it (upstream's own default, if any, applies), e.g. keys of a
	 * feature upstream introduced in that release.
	 */
	min_version: z.string().min(1).max(100).optional(),
	/**
	 * Deploy form default taken from the signed-in user (e.g. the admin
	 * email = the account's email instead of `admin@<generated domain>`).
	 */
	prefill: z.enum(["account_email"]).optional(),
	/**
	 * Team permission needed (besides the edit permission) to set this
	 * variable: deploy form, env editor. For values that amount to more
	 * than configuration, e.g. a URL code is loaded from.
	 */
	permission: z
		.enum(teamPermissionIds as [Permission, ...Permission[]])
		.optional(),
});

export type TemplateVariable = z.infer<typeof TemplateVariableSchema>;

const VARIABLE_TYPE_CHECKS: Record<
	TemplateVariable["type"],
	(value: string) => boolean
> = {
	string: () => true,
	email: (value) => z.email().safeParse(value).success,
	url: (value) => z.url().safeParse(value).success,
	hostname: (value) =>
		/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/i.test(
			value,
		),
	integer: (value) => /^-?\d+$/.test(value),
	boolean: (value) => /^(true|false)$/.test(value),
};

/**
 * Validate a user-provided value. Returns a coded problem (rendered with
 * `errorText`) or null.
 */
export function validateVariableValue(
	name: string,
	variable: Pick<
		TemplateVariable,
		"type" | "min_length" | "max_length" | "pattern"
	> &
		Partial<TemplateVariable>,
	value: string,
): ErrorInfo | null {
	if (!VARIABLE_TYPE_CHECKS[variable.type](value)) {
		return coded("VARIABLE_TYPE_INVALID", { name, type: variable.type });
	}
	if (variable.min_length !== undefined && value.length < variable.min_length) {
		return coded("VARIABLE_TOO_SHORT", { name, min: variable.min_length });
	}
	if (variable.max_length !== undefined && value.length > variable.max_length) {
		return coded("VARIABLE_TOO_LONG", { name, max: variable.max_length });
	}
	if (variable.pattern && !new RegExp(variable.pattern).test(value)) {
		return coded("VARIABLE_FORMAT_INVALID", { name });
	}
	return null;
}

const envName = z.string().regex(ENV_NAME_PATTERN);

const TemplateDomainSchema = z.object({
	service: z.string().min(1),
	port: z.number().int().min(1).max(65535),
	primary: z.boolean().default(false),
	/**
	 * Host label of a secondary domain: `<subdomain>.<primary domain>`
	 * (default: the service name). Needed when one service is routed on
	 * several ports (e.g. an API and a console).
	 */
	subdomain: z.string().regex(SLUG_PATTERN).optional(),
	/**
	 * Redirect requests for `/` to this path (e.g. a web console mounted
	 * under `/console/`). Applied to every domain routed to this service
	 * and port.
	 */
	root_redirect: z
		.string()
		.regex(/^\/[A-Za-z0-9._~\-/]*$/)
		.optional(),
	/**
	 * Path-based routes on the same host(s) to other services, e.g. an API
	 * under `/v1` while the UI serves `/`. Applied to every domain routed to
	 * this service; the longest prefix wins.
	 */
	paths: z
		.array(
			z.object({
				prefix: z.string().regex(/^\/[A-Za-z0-9._~\-/]*$/),
				service: serviceName,
				port: z.number().int().min(1).max(65535),
			}),
		)
		.default([]),
	https: z.boolean().default(true),
	path_prefix: z.string().optional(),
	/**
	 * HTTP basic auth (Traefik middleware) for every domain routed to this
	 * service, with credentials taken from these variables.
	 */
	basic_auth: z.object({ username: envName, password: envName }).optional(),
});

/** A container port the owner may publish on the host (opt-in, off by default). */
const TemplatePortSchema = z.object({
	id: z.string().regex(SLUG_PATTERN),
	service: serviceName,
	port: z.number().int().min(1).max(65535),
	label: templateText().min(1),
	description: templateText().optional(),
	i18n: noLocaleTexts,
	/** Suggested host port when the owner enables it. */
	default_host_port: z.number().int().min(1024).max(65535).optional(),
});

const TemplateHealthSchema = z.object({
	/** Service to probe; defaults to the primary domain's service. */
	service: z.string().optional(),
	/** HTTP path probed on the service's port from the proxy network. */
	path: z
		.string()
		.regex(/^\/[A-Za-z0-9._~\-/?=&]*$/)
		.optional(),
	port: z.number().int().min(1).max(65535).optional(),
	timeout_seconds: z.number().int().min(5).max(1800).optional(),
	/**
	 * How long every service must stay ready without restarting before the
	 * deploy counts it as up (default: `APP_READY_STABLE_MS`).
	 */
	stable_seconds: z.number().int().min(0).max(600).optional(),
	/**
	 * How long a service may stay `unhealthy` before the deploy fails
	 * (default: `APP_UNHEALTHY_GRACE_MS`).
	 */
	unhealthy_grace_seconds: z.number().int().min(0).max(1800).optional(),
	/**
	 * Restarts of one service that fail the deploy, counted once every
	 * service has been up (default: `APP_DEPLOY_RESTART_LIMIT`).
	 */
	restart_limit: z.number().int().min(1).max(100).optional(),
	/** HTTP statuses that count as healthy (default: anything below 500). */
	expect: z.array(z.number().int().min(100).max(599)).min(1).optional(),
});

const appRelativeDir = relativePath.refine(
	(value) => !value.endsWith("/") && value !== ".",
	"must be a folder inside the app",
);

/** A file or folder inside the app folder (not the folder itself). */
const appRelativeEntry = relativePath.refine(
	(value) => !value.endsWith("/") && value !== "." && value !== "./",
	"must be a path inside the app folder",
);

/**
 * `[backup.database]` table: `type` picks a strategy from the dump registry,
 * which validates the remaining keys with its own schema.
 */
const DatabaseDumpSchema = z
	.object({
		type: z.string().regex(SLUG_PATTERN),
		/** Compose service of the database. */
		service: serviceName,
		/**
		 * Earlier strategy ids whose archives this one restores (e.g. a
		 * plugin strategy this one replaced).
		 */
		legacy_ids: z.array(z.string().regex(/^[a-z0-9:-]+$/)).default([]),
	})
	.catchall(z.unknown());

export type DatabaseDump = z.infer<typeof DatabaseDumpSchema>;

/** Service of `[backup].database` (string or table form). */
export function backupDatabaseService(
	backup: Pick<TemplateBackup, "database">,
): string | undefined {
	return typeof backup.database === "string"
		? backup.database
		: backup.database?.service;
}

/** What a full backup contains and how to take it (template `[backup]`). */
export const TemplateBackupSchema = z
	.object({
		/** Bind-mounted folders inside the app folder to archive. */
		paths: z.array(appRelativeDir).default([]),
		/** Compose named volumes (names as in the compose file) to archive. */
		volumes: z.array(serviceName).default([]),
		/**
		 * Services stopped while files are archived (consistent copies):
		 * `true` = all, `false` = none (online), or a list.
		 */
		stop: z.union([z.boolean(), z.array(serviceName)]).default(true),
		/**
		 * Database dump: a generic strategy from the registry
		 * (`{ type = "postgres", service = "db", ... }`, see
		 * `src/server/services/backup/db-strategies.ts`), or a service name
		 * for the provider plugin's own strategy.
		 */
		database: z.union([serviceName, DatabaseDumpSchema]).optional(),
		/** Folders emptied before a database dump is restored (fresh init). */
		reset: z.array(appRelativeDir).default([]),
		/** Named volumes emptied before a database dump is restored. */
		reset_volumes: z.array(serviceName).default([]),
		/** Commands run in a service (`docker exec`) around the backup. */
		hooks: z
			.array(
				z.object({
					when: z.enum(["pre", "post"]),
					service: serviceName,
					command: z.array(z.string().min(1)).min(1),
				}),
			)
			.default([]),
	})
	.default({
		paths: [],
		volumes: [],
		stop: true,
		reset: [],
		reset_volumes: [],
		hooks: [],
	});

export type TemplateBackup = z.infer<typeof TemplateBackupSchema>;

/**
 * Services a backup stops (`[backup] stop`, limited to `running`), split
 * around the database dump: `beforeDump` are stopped first so the dump
 * holds every write they acknowledged; `afterDump` is the service the dump
 * runs against (when it is in the stop set), stopped once the dump is done
 * and before the volumes are copied. Without a dump everything is stopped
 * before the copy.
 *
 * Order: a service stops before every service it depends on (`dependsOn`,
 * followed transitively, also through services outside the set), so no
 * writer keeps sending to a stopped dependency (e.g. Plausible buffering
 * events for ClickHouse). Ties keep the template's list order (`stop` as a
 * list), else the order of `running`. Starting again goes in reverse.
 */
export function backupStopPhases(
	backup: Pick<TemplateBackup, "stop">,
	running: readonly string[],
	dumpService: string | null,
	dependsOn: Readonly<Record<string, readonly string[]>> = {},
): { beforeDump: string[]; afterDump: string[] } {
	const listed = backup.stop;
	const base =
		listed === true
			? [...running]
			: listed === false
				? []
				: [...new Set(listed)].filter((service) => running.includes(service));
	const stop = dependentsFirst(base, dependsOn);
	return {
		beforeDump: stop.filter((service) => service !== dumpService),
		afterDump: stop.filter((service) => service === dumpService),
	};
}

/** `services` reordered so dependents come before what they depend on. */
function dependentsFirst(
	services: readonly string[],
	dependsOn: Readonly<Record<string, readonly string[]>>,
): string[] {
	const reach = new Map<string, Set<string>>();
	const reachable = (service: string): Set<string> => {
		const known = reach.get(service);
		if (known) return known;
		const out = new Set<string>();
		reach.set(service, out);
		for (const target of dependsOn[service] ?? []) {
			out.add(target);
			for (const next of reachable(target)) out.add(next);
		}
		return out;
	};
	const left = [...services];
	const out: string[] = [];
	while (left.length) {
		// First (list order) that nothing left still depends on; a cycle
		// falls back to list order.
		const index = left.findIndex(
			(service) =>
				!left.some(
					(other) => other !== service && reachable(other).has(service),
				),
		);
		out.push(...left.splice(index === -1 ? 0 : index, 1));
	}
	return out;
}

const TemplateSecuritySchema = z
	.object({
		privileged: z.boolean().default(false),
		host_network: z.boolean().default(false),
		host_pid: z.boolean().default(false),
		docker_socket: z.boolean().default(false),
		cap_add: z.array(z.string()).default([]),
		devices: z.array(z.string()).default([]),
		security_opt: z.array(z.string()).default([]),
		host_paths: z.array(absolutePath).default([]),
		external: z.array(z.string()).default([]),
		/**
		 * Why the template needs what it allows (required when anything is
		 * allowed): shown as a warning in the marketplace, preview and wizard.
		 */
		reason: templateText().optional(),
		i18n: noLocaleTexts,
	})
	.default({
		privileged: false,
		host_network: false,
		host_pid: false,
		docker_socket: false,
		cap_add: [],
		devices: [],
		security_opt: [],
		host_paths: [],
		external: [],
	});

const TemplateResourcesSchema = z
	.object({
		/** Hard memory limit in MiB. */
		memory_mb: z.number().int().min(6).max(1_048_576).optional(),
		/** Soft memory reservation in MiB. */
		memory_reservation_mb: z.number().int().min(1).max(1_048_576).optional(),
		/** CPU limit in cores (e.g. 0.5). */
		cpus: z.number().min(0.01).max(1024).optional(),
	})
	.strict();

const TemplateLinkSchema = z
	.object({
		/** Button text (English; extracted for translation). */
		label: templateText().min(1).max(60),
		/** Path on the domain, e.g. "/_/". */
		path: z
			.string()
			.regex(/^\/[A-Za-z0-9._~\-/?=&#]*$/)
			.default("/"),
		/** Routed service whose domain the link opens (default: primary). */
		service: serviceName.optional(),
		/** The main "Open" action of the app page. */
		primary: z.boolean().default(false),
	})
	.strict();

export const TemplateManifestSchema = z
	.object({
		id: z.string().regex(SLUG_PATTERN),
		name: templateText().min(1),
		description: templateText().default(""),
		/** Marketplace grouping (category registry: `#/config/template-categories.ts`). */
		category: z.string().regex(SLUG_PATTERN).default("other"),
		website: z.url().optional(),
		/** Self-hosting documentation. */
		docs: z.url().optional(),
		logo: relativePath.default("logo.svg"),
		/**
		 * Tint of the app's icon (a Mantine palette colour, e.g. "teal"),
		 * also behind the fallback icon when the logo is missing. Default:
		 * the colour of the template's source kind (`#/config/app-sources.ts`).
		 */
		color: z
			.string()
			.refine((value) => value in DEFAULT_THEME.colors, {
				message: `Unknown colour: use one of ${Object.keys(DEFAULT_THEME.colors).join(", ")}`,
			})
			.optional(),
		tags: z.array(z.string().regex(SLUG_PATTERN)).default([]),
		i18n: noLocaleTexts,
		/** Minimum Docker Engine version (checked by the deploy pre-flight). */
		min_docker_version: z
			.string()
			.regex(/^\d+(\.\d+){0,2}$/)
			.optional(),
		/**
		 * What to do after the first deploy (e.g. "register the owner account
		 * now"), shown on the app page and in the wizard review.
		 */
		notes: templateText().optional(),
		/**
		 * A short, important limitation of this template (e.g. a feature that
		 * is disabled), shown on the marketplace card and the app page.
		 */
		limitation: templateText().max(200).optional(),
		/** For experienced users (badge + confirmation in the wizard). */
		advanced: z.boolean().default(false),
		/**
		 * Compose overlay in the template dir, deep-merged onto the (upstream)
		 * compose before the transform: mappings merge, lists and scalars
		 * replace, `null` removes a key (e.g. a service).
		 */
		overlay: relativePath.default("overlay.yml"),
		/**
		 * More overlays (template dir), merged after `overlay` in order, each
		 * only for upstream versions >= `min_version` (e.g. enabling a feature
		 * upstream ships commented out from that release on).
		 */
		overlays: z
			.array(
				z
					.object({
						path: relativePath,
						min_version: z.string().min(1).max(100),
					})
					.strict(),
			)
			.default([]),
		source: TemplateSourceSchema,
		/**
		 * Bind sources inside the app folder (files or folders, relative to
		 * it) that the app creates or fills itself at runtime: never expected
		 * to exist as files before `up`, even when named like one (e.g.
		 * `data/app.json`). See "Bind mounts of files" in templates/README.md.
		 */
		data_binds: z.array(appRelativeEntry).max(100).default([]),
		variables: z
			.record(z.string().regex(ENV_NAME_PATTERN), TemplateVariableSchema)
			.default({}),
		domains: z.array(TemplateDomainSchema).default([]),
		security: TemplateSecuritySchema,
		health: TemplateHealthSchema.optional(),
		/** Minimum free resources checked by the deploy pre-flight. */
		requirements: z
			.object({
				memory_mb: z.number().int().min(0).default(0),
				disk_mb: z.number().int().min(0).default(0),
			})
			.default({ memory_mb: 0, disk_mb: 0 }),
		backup: TemplateBackupSchema,
		/** Container ports that may be published on the host (opt-in). */
		ports: z.array(TemplatePortSchema).default([]),
		/**
		 * Default resource limits per service (M6), overridable per app.
		 * Applied as `deploy.resources` by the compose transform.
		 */
		resources: z.record(serviceName, TemplateResourcesSchema).default({}),
		/**
		 * Quick links on the app page (e.g. "Admin console" → `/_/`), opened
		 * on the app's domain for `service` (default: the primary domain).
		 */
		links: z.array(TemplateLinkSchema).default([]),
		/**
		 * Services that get a Nitrobase-managed secret env file
		 * (`service-env/<service>.env`, values encrypted in the DB).
		 */
		service_env: z.array(serviceName).default([]),
		/**
		 * Services left without a restart policy when they declare none
		 * (every other one gets `APP_DEFAULT_RESTART`): one-shot jobs the
		 * transform cannot tell apart (no `service_completed_successfully`
		 * dependent). An explicit `restart: "no"` in the compose works too.
		 */
		no_default_restart: z.array(serviceName).default([]),
		/**
		 * Opt-in text substitutions in the fetched files, applied only when
		 * the variable `when` is set (non-empty): e.g. pointing an upstream
		 * file's package imports at a mirror the owner configures. `find` is
		 * literal; `replace` may reference template variables as `${NAME}`
		 * (values limited to URL characters). Without the variable set,
		 * upstream files are deployed unchanged.
		 */
		rewrites: z
			.array(
				z
					.object({
						path: relativePath,
						find: z.string().min(1),
						replace: z.string(),
						when: envName,
					})
					.strict(),
			)
			.default([]),
		/**
		 * Workarounds named in deploy hints for known failure signatures
		 * (`#/config/failure-signatures.ts`), e.g. the variable that sets a
		 * package mirror.
		 */
		failure_hints: z
			.partialRecord(
				z.enum(FAILURE_SIGNATURE_IDS),
				z.object({ variable: envName.optional() }).strict(),
			)
			.default({}),
		/** Settings read by this template's provider plugin (its own schema). */
		plugin: z.record(z.string(), z.unknown()).default({}),
		/**
		 * One-click and automatic updates (R4 M4): how a failed update is
		 * undone. `redeploy` (default) deploys the previous version again;
		 * `restore` restores the backup taken before the update (use it
		 * when new versions migrate data irreversibly); `manual` leaves the
		 * app as it is for the owner to fix.
		 */
		updates: z
			.object({
				rollback: z.enum(ROLLBACK_MODES).default("redeploy"),
			})
			.strict()
			.default({ rollback: "redeploy" }),
	})
	.superRefine((manifest, ctx) => {
		if (manifest.source.type === "github" && !manifest.source.repo) {
			ctx.addIssue({
				code: "custom",
				message: "source.repo is required for GitHub templates",
				path: ["source", "repo"],
			});
		}
		if (
			allowedSecurity(manifest.security).length &&
			!manifest.security.reason
		) {
			ctx.addIssue({
				code: "custom",
				message: "security.reason must explain what the template allows",
				path: ["security", "reason"],
			});
		}
		// The HTTP probe runs from a throwaway container on the proxy network
		// (works for any image, no curl needed inside it), so the probed
		// service must be routed, i.e. listed in [[domains]].
		if (manifest.health?.path) {
			const service =
				manifest.health.service ??
				(manifest.domains.find((d) => d.primary) ?? manifest.domains[0])
					?.service;
			const routed = manifest.domains.flatMap((d) => [
				d.service,
				...d.paths.map((path) => path.service),
			]);
			if (!service || !routed.includes(service)) {
				ctx.addIssue({
					code: "custom",
					message:
						"health.service must be a service routed by [[domains]] (or its paths)",
					path: ["health", "service"],
				});
			}
		}
		for (const [index, domain] of manifest.domains.entries()) {
			for (const field of ["username", "password"] as const) {
				const name = domain.basic_auth?.[field];
				if (name && !(name in manifest.variables)) {
					ctx.addIssue({
						code: "custom",
						message: `basic_auth.${field} must be a variable of this template`,
						path: ["domains", index, "basic_auth", field],
					});
				}
			}
		}
		const routedServices = new Set(manifest.domains.map((d) => d.service));
		for (const [index, link] of manifest.links.entries()) {
			if (link.service && !routedServices.has(link.service)) {
				ctx.addIssue({
					code: "custom",
					message: "links.service must be a service routed by [[domains]]",
					path: ["links", index, "service"],
				});
			}
		}
		for (const [index, rewrite] of manifest.rewrites.entries()) {
			const refs = [...rewrite.replace.matchAll(/\$\{([^}]*)\}/g)].map(
				(match) => match[1].trim(),
			);
			for (const name of [rewrite.when, ...refs]) {
				if (!(name in manifest.variables)) {
					ctx.addIssue({
						code: "custom",
						message: `rewrites may only use template variables (${name})`,
						path: ["rewrites", index],
					});
				}
			}
			if (
				rewrite.path === manifest.source.compose ||
				rewrite.path === manifest.source.env_defaults
			) {
				ctx.addIssue({
					code: "custom",
					message:
						"rewrites apply to copied files, not the compose or env defaults file (use an overlay)",
					path: ["rewrites", index, "path"],
				});
			}
		}
		for (const [id, hint] of Object.entries(manifest.failure_hints)) {
			if (hint?.variable && !manifest.variables[hint.variable]?.editable) {
				ctx.addIssue({
					code: "custom",
					message: "failure_hints.variable must be an editable variable",
					path: ["failure_hints", id, "variable"],
				});
			}
		}
		const portIds = manifest.ports.map((port) => port.id);
		if (new Set(portIds).size !== portIds.length) {
			ctx.addIssue({
				code: "custom",
				message: "port ids must be unique",
				path: ["ports"],
			});
		}
		for (const [name, variable] of Object.entries(manifest.variables)) {
			if (
				variable.rotatable &&
				!/\$\{(password|base64|hex|uuid|opaque_key|signing_keys):?/.test(
					variable.value,
				)
			) {
				ctx.addIssue({
					code: "custom",
					message: "only generated variables can be rotatable",
					path: ["variables", name, "rotatable"],
				});
			}
			if (variable.initial_only && variable.rotatable) {
				ctx.addIssue({
					code: "custom",
					message:
						"initial_only variables cannot be rotatable (the app ignores later values)",
					path: ["variables", name, "rotatable"],
				});
			}
			if (variable.initial_only) {
				const rotatable = referencedRotatable(manifest.variables, name);
				if (rotatable) {
					ctx.addIssue({
						code: "custom",
						message: `initial_only variables cannot depend on a rotatable one (${rotatable}): a rotation would not reach the app`,
						path: ["variables", name, "initial_only"],
					});
				}
			}
			if (variable.on_rotate && !variable.rotatable) {
				ctx.addIssue({
					code: "custom",
					message: "on_rotate needs rotatable = true",
					path: ["variables", name, "on_rotate"],
				});
			}
		}
		// `min_version` compares version names; commit SHAs have no order.
		const versioned =
			manifest.source.type === "github" &&
			manifest.source.versions !== "commits";
		if (!versioned) {
			const message =
				"min_version needs named versions (source.versions = releases, tags or branches)";
			for (const [name, variable] of Object.entries(manifest.variables)) {
				if (variable.min_version !== undefined) {
					ctx.addIssue({
						code: "custom",
						message,
						path: ["variables", name, "min_version"],
					});
				}
			}
			manifest.overlays.forEach((_, index) => {
				ctx.addIssue({
					code: "custom",
					message,
					path: ["overlays", index, "min_version"],
				});
			});
			manifest.source.include.forEach((item, index) => {
				if (typeof item === "string") return;
				ctx.addIssue({
					code: "custom",
					message,
					path: ["source", "include", index, "min_version"],
				});
			});
			if (manifest.source.min_version !== undefined) {
				ctx.addIssue({
					code: "custom",
					message,
					path: ["source", "min_version"],
				});
			}
		}
		const labels = manifest.domains
			.filter((d) => !d.primary)
			.map((d) => d.subdomain ?? d.service);
		if (new Set(labels).size !== labels.length) {
			ctx.addIssue({
				code: "custom",
				message:
					"secondary domains need distinct hosts: set `subdomain` on one of them",
				path: ["domains"],
			});
		}
		if (manifest.domains.filter((d) => d.primary).length > 1) {
			ctx.addIssue({
				code: "custom",
				message: "only one domain may be primary",
				path: ["domains"],
			});
		}
	});

export type TemplateManifest = z.infer<typeof TemplateManifestSchema>;
export type TemplateSecurity = z.infer<typeof TemplateSecuritySchema>;

/** What a template's `[security]` allows, e.g. `docker_socket`, `cap_add: NET_ADMIN`. */
export function allowedSecurity(security: TemplateSecurity): string[] {
	return [
		...(["privileged", "host_network", "host_pid", "docker_socket"] as const)
			.filter((key) => security[key])
			.map((key) => key),
		...(
			["cap_add", "devices", "security_opt", "host_paths", "external"] as const
		).flatMap((key) => security[key].map((item) => `${key}: ${item}`)),
	];
}
export type TemplateDomain = z.infer<typeof TemplateDomainSchema>;
export type TemplateSource = z.infer<typeof TemplateSourceSchema>;

export interface TemplateVersion {
	/** Git ref to deploy (tag name or commit SHA). */
	ref: string;
	name: string;
	publishedAt: string | null;
	prerelease: boolean;
	/** Release notes page, when the source has one (GitHub releases). */
	url?: string | null;
}

export interface TemplateInput {
	name: string;
	description?: string;
	secret: boolean;
	type: TemplateVariable["type"];
	minLength?: number;
	/** Human label (template.toml `label`), falls back to the name. */
	label?: string;
	/** Example/default shown as placeholder (literal values only). */
	placeholder?: string;
	/** Deploy form section (English; translated in the UI). */
	group?: string;
	/** Left empty, the value is generated (random secret). */
	generated: boolean;
	/** Deploy form default from the signed-in user. */
	prefill?: TemplateVariable["prefill"];
	/** Extra team permission needed to set it (template `permission`). */
	permission?: Permission;
}

/** A templates/ folder that could not be loaded (validation message). */
export interface TemplateProblem {
	folder: string;
	/** Coded problem; zod issues are its `detail`. */
	error: ErrorInfo;
}

export interface TemplateSummary {
	/** Editable variables the deploy form may ask for. */
	inputs: TemplateInput[];
	id: string;
	name: string;
	description: string;
	/** After-deploy instructions (English; translated in the UI). */
	notes: string | null;
	/** Short limitation label (English; translated in the UI). */
	limitation: string | null;
	category: string;
	website?: string;
	docs?: string;
	tags: string[];
	hasLogo: boolean;
	/** `color` of template.toml (null: the source kind's colour). */
	color: string | null;
	/** Owner-defined sources (custom compose, git) have no versions. */
	versionSource:
		| TemplateSource["versions"]
		| Exclude<TemplateSourceType, "github">;
	/** App source kind (#/config/app-sources.ts). */
	sourceKind: AppSourceKind;
	requirements: { memoryMb: number; diskMb: number };
	minDockerVersion: string | null;
	advanced: boolean;
	repo: string | null;
	/** What `[security]` allows beyond the default policy (warned in the UI). */
	security: {
		allows: string[];
		reason: string | null;
	};
}

// Server function inputs

const TemplateIdSchema = z.string().regex(SLUG_PATTERN);

export const TemplateVersionsInputSchema = z.object({
	templateId: TemplateIdSchema,
	includePrereleases: z.boolean().default(false),
	refresh: z.boolean().default(false),
});

// ---------------------------------------------------------------------------
// Custom compose (template with `source.type = "inline"`)

/** Limits of a pasted compose file / env. */
/** What a pasted compose file declares and what the policy says about it. */
export interface CustomComposeAnalysis {
	services: { name: string; image: string | null; ports: number[] }[];
	volumes: string[];
	/**
	 * Bind sources in the app folder named like files (e.g. `config.json`):
	 * they must exist as files on the server unless the app creates them
	 * (then listed in the spec's `dataBinds`).
	 */
	fileBinds: string[];
	/** `${NAME}` the compose reads that the env doesn't set (and no default). */
	missingEnv: string[];
	/** Policy refusal (the compose can't be deployed as is), or null. */
	error: ErrorInfo | null;
	warnings: ErrorInfo[];
}

export const CUSTOM_COMPOSE_MAX_BYTES = 200_000;
export const CUSTOM_ENV_MAX_BYTES = 100_000;

const CustomRouteSchema = z.object({
	service: serviceName,
	port: z.number().int().min(1).max(65535),
});

/**
 * What the owner supplies for a custom-compose app. Stored encrypted with
 * the app (the env may hold secrets); every render goes through the same
 * transform and policy as a template.
 */
export const CustomComposeSpecSchema = z.object({
	compose: z.string().min(1).max(CUSTOM_COMPOSE_MAX_BYTES),
	/** `KEY=value` lines, used for compose interpolation (`${KEY}`). */
	env: z.string().max(CUSTOM_ENV_MAX_BYTES).default(""),
	/** First = primary domain; others get `<service>.<domain>`. */
	routes: z.array(CustomRouteSchema).min(1).max(20),
	/** Named volumes included in backups. */
	backupVolumes: z.array(serviceName).max(100).default([]),
	/**
	 * Bind sources in the app folder the app creates itself at runtime
	 * (template `data_binds`): no warning or check that they are files.
	 */
	dataBinds: z.array(appRelativeEntry).max(100).default([]),
});

export type CustomComposeSpec = z.infer<typeof CustomComposeSpecSchema>;

/**
 * The effective manifest of a custom-compose app: the template's (no
 * variables, nothing allowed in `[security]`) with the owner's routes and
 * backup volumes. Services are stopped while volumes are archived (no
 * database dump: the data's consistency is unknown).
 */
export function customManifest(
	manifest: TemplateManifest,
	spec: Pick<CustomComposeSpec, "routes" | "backupVolumes"> &
		Partial<Pick<CustomComposeSpec, "dataBinds">>,
): TemplateManifest {
	return {
		...manifest,
		data_binds: spec.dataBinds ?? [],
		domains: spec.routes.map((route, index) => ({
			service: route.service,
			port: route.port,
			primary: index === 0,
			https: true,
			paths: [],
		})),
		backup: {
			...manifest.backup,
			paths: [],
			volumes: spec.backupVolumes,
			stop: true,
			database: undefined,
		},
	};
}

/** Default host of a template domain for an app whose primary domain is `primary`. */
export function templateDomainHost(
	domain: Pick<TemplateDomain, "primary" | "service" | "subdomain">,
	primary: string,
): string {
	return domain.primary
		? primary
		: `${domain.subdomain ?? domain.service}.${primary}`;
}
