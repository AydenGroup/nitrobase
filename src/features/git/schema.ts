import { z } from "zod";
import { ENV_NAME_PATTERN, RESERVED_ENV_PATTERN } from "#/libs/naming-rules.ts";

/**
 * Git apps (R2 M1): client-safe schemas and DTOs. An app built from the
 * owner's repository: where the code is (source), how it becomes an image
 * (build), how the image runs (runtime). Values here are structural; the
 * server checks URLs (SSRF), credentials and limits.
 */

export const BUILDER_IDS = ["dockerfile", "railpack", "static"] as const;
export type BuilderId = (typeof BUILDER_IDS)[number];
/** `auto` = detect on every build (the result is shown in the log). */
export const BUILDER_CHOICES = ["auto", ...BUILDER_IDS] as const;
export type BuilderChoice = (typeof BUILDER_CHOICES)[number];

export const GIT_AUTH_KINDS = ["none", "deploy_key", "token"] as const;
export type GitAuthKind = (typeof GIT_AUTH_KINDS)[number];

/** The one service of a git app's generated compose. */
export const GIT_APP_SERVICE = "app";

export const GIT_URL_MAX_LENGTH = 500;
const BUILD_COMMAND_MAX_LENGTH = 2000;
/** Port a new git app listens on unless the wizard says otherwise. */
export const DEFAULT_APP_PORT = 3000;
const BUILD_VARS_MAX = 100;
const BUILD_VALUE_MAX_LENGTH = 16_384;
export const RUNTIME_VOLUMES_MAX = 10;

/**
 * Branch names: git check-ref-format rules that matter here (no `..`,
 * no leading `-` or `/`, no `@{`, no control chars/spaces/`~^:?*[\`).
 */
const GIT_BRANCH_PATTERN =
	/^(?![-/])(?!.*\.\.)(?!.*\/\/)(?!.*@\{)(?!.*\.lock$)(?!.*\/$)[A-Za-z0-9._/-]{1,200}$/;

/** A repository subdirectory (monorepo): relative, no `..`, no leading `/`. */
const SUBDIR_PATTERN =
	/^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._@+/-]{0,200}$/;

const relPath = z
	.string()
	.trim()
	.max(300)
	.regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._@+/ -]+$/);

const envName = z
	.string()
	.regex(ENV_NAME_PATTERN)
	.refine((name) => !RESERVED_ENV_PATTERN.test(name));

const envRecord = z
	.record(envName, z.string().max(BUILD_VALUE_MAX_LENGTH))
	.refine((record) => Object.keys(record).length <= BUILD_VARS_MAX);

/** Image reference (registry/name:tag or @digest). */
const IMAGE_REF_PATTERN = /^[a-z0-9][a-z0-9._/:@-]{0,254}$/;

const GitSourceSchema = z.object({
	repoUrl: z.string().trim().min(1).max(GIT_URL_MAX_LENGTH),
	branch: z.string().trim().regex(GIT_BRANCH_PATTERN),
	/** Directory inside the repository to build ("" = root). */
	subdir: z.string().trim().regex(SUBDIR_PATTERN).default(""),
	submodules: z.boolean().default(false),
	auth: z.enum(GIT_AUTH_KINDS).default("none"),
	/** Deploy key or token (from the wizard / Settings), when auth needs one. */
	credentialId: z.guid().nullable().default(null),
	/**
	 * The repository host may resolve to a private address (self-hosted
	 * Gitea on the same network). Off: such hosts are refused (SSRF guard).
	 */
	allowPrivateHost: z.boolean().default(false),
});
export type GitSource = z.infer<typeof GitSourceSchema>;

const BuildLimitsSchema = z.object({
	memoryMb: z.number().int().min(256).max(1_048_576).nullable().default(null),
	cpus: z.number().min(0.1).max(256).nullable().default(null),
	timeoutSeconds: z.number().int().min(30).nullable().default(null),
});

export const BuildSettingsSchema = z.object({
	builder: z.enum(BUILDER_CHOICES).default("auto"),
	dockerfile: z
		.object({
			path: relPath.default("Dockerfile"),
			target: z
				.string()
				.regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/)
				.nullable()
				.default(null),
			/** Plain build arguments (`--build-arg`); secrets go in build secrets. */
			buildArgs: envRecord.default({}),
		})
		.default({ path: "Dockerfile", target: null, buildArgs: {} }),
	static: z
		.object({
			/** Build image (default STATIC_BUILD_IMAGE); empty = config default. */
			buildImage: z.string().regex(IMAGE_REF_PATTERN).nullable().default(null),
			/** Shell command run in the build image ("" = no build step). */
			buildCommand: z.string().max(BUILD_COMMAND_MAX_LENGTH).default(""),
			/** Folder served (relative to the build directory). */
			outputDir: relPath.default("dist"),
		})
		.default({ buildImage: null, buildCommand: "", outputDir: "dist" }),
	limits: BuildLimitsSchema.default({
		memoryMb: null,
		cpus: null,
		timeoutSeconds: null,
	}),
});
export type BuildSettings = z.infer<typeof BuildSettingsSchema>;

const RuntimeVolumeSchema = z.object({
	name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/),
	mountPath: z
		.string()
		.regex(/^\/[A-Za-z0-9._@+/-]*$/)
		.max(300)
		.refine(
			(value) =>
				value !== "/" && !value.split("/").some((part) => part === ".."),
		),
});

export const RuntimeSettingsSchema = z.object({
	/** Port the app listens on inside the container (`PORT` env is set to it). */
	port: z.number().int().min(1).max(65535),
	/** HTTP path probed after a deploy ("" = container running is enough). */
	healthPath: z
		.string()
		.max(500)
		.regex(/^(\/[A-Za-z0-9._~\-/?=&]*)?$/)
		.default(""),
	/** Named volumes the owner declares (persistent data; backed up). */
	volumes: z.array(RuntimeVolumeSchema).max(RUNTIME_VOLUMES_MAX).default([]),
});
export type RuntimeSettings = z.infer<typeof RuntimeSettingsSchema>;

/** What the wizard sends to create a git app. */
export const GitAppSpecSchema = z.object({
	source: GitSourceSchema,
	build: BuildSettingsSchema,
	runtime: RuntimeSettingsSchema,
	/** Runtime env (the app's env editor afterwards). */
	env: envRecord.default({}),
	/** Build-time secrets (BuildKit secrets, never build args or layers). */
	buildSecrets: envRecord.default({}),
	webhook: z.boolean().default(true),
	/** Images kept for rollback (null = GIT_KEEP_IMAGES). */
	keepImages: z.number().int().min(1).nullable().default(null),
});
export type GitAppSpec = z.infer<typeof GitAppSpecSchema>;

// ---------------------------------------------------------------------------
// Server function inputs

export const InspectRepoInputSchema = z.object({
	serverId: z.guid(),
	source: GitSourceSchema,
});

export const CreateCredentialInputSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("deploy_key"), appId: z.guid().optional() }),
	z.object({
		kind: z.literal("token"),
		appId: z.guid().optional(),
		username: z
			.string()
			.trim()
			.regex(/^[A-Za-z0-9._@-]{1,100}$/),
		token: z.string().trim().min(1).max(2000),
	}),
]);

export const UpdateGitSourceInputSchema = z.object({
	appId: z.guid(),
	source: GitSourceSchema,
});

export const UpdateBuildInputSchema = z.object({
	appId: z.guid(),
	build: BuildSettingsSchema,
	runtime: RuntimeSettingsSchema,
	keepImages: z.number().int().min(1).nullable(),
});

export const BuildSecretsEditSchema = z.object({
	appId: z.guid(),
	set: envRecord.default({}),
	remove: z.array(envName).max(BUILD_VARS_MAX).default([]),
});

export const WebhookSettingsInputSchema = z.object({
	appId: z.guid(),
	enabled: z.boolean(),
});

export const DeployCommitInputSchema = z.object({
	appId: z.guid(),
	/** Build this commit (default: the branch tip). */
	commitSha: z
		.string()
		.regex(/^[0-9a-f]{40}$/)
		.optional(),
});

export const RollbackInputSchema = z.object({
	appId: z.guid(),
	releaseId: z.guid(),
});

// ---------------------------------------------------------------------------
// DTOs

export interface BuilderDetection {
	/** null = nothing recognised (choose a builder). */
	builder: BuilderId | null;
	/** Why (code + params, rendered in the UI). */
	reason: DetectionReason;
	/** Port suggestion (Dockerfile EXPOSE, static server, PORT default). */
	port: number;
	/** Static sites: suggested build command / output directory. */
	buildCommand?: string;
	outputDir?: string;
}

export type DetectionReason =
	| { code: "dockerfile"; path: string }
	| { code: "static_framework"; framework: string }
	| { code: "static_html" }
	| { code: "railpack"; marker: string }
	| { code: "nothing" };

export interface RepoInspection {
	commitSha: string;
	message: string;
	author: string;
	committedAt: string | null;
	detection: BuilderDetection;
	/** Top-level entries of the build directory (names only). */
	files: string[];
	/** Instance defaults the wizard shows (build limits, retention). */
	defaults: GitDefaults;
}

export interface GitDefaults {
	limits: { memoryMb: number; cpus: number; timeoutSeconds: number };
	maxTimeoutSeconds: number;
	keepImages: number;
}

export interface GitCredentialView {
	id: string;
	kind: Exclude<GitAuthKind, "none">;
	/** Deploy key: the public key to add to the repository. */
	publicKey: string | null;
	fingerprint: string | null;
	username: string | null;
	createdAt: Date;
}

const RELEASE_STATUSES = ["building", "ready", "failed", "pruned"] as const;
export type ReleaseStatus = (typeof RELEASE_STATUSES)[number];

export interface ReleaseView {
	id: string;
	commitSha: string;
	message: string;
	author: string;
	committedAt: Date | null;
	builder: string | null;
	status: ReleaseStatus;
	imageTag: string;
	/** Currently running image. */
	live: boolean;
	buildDeploymentId: string | null;
	buildDurationMs: number | null;
	lastDeployedAt: Date | null;
	createdAt: Date;
	/** "Roll back to this" is possible (image kept, not live). */
	rollbackable: boolean;
}

const DELIVERY_STATUSES = [
	"queued",
	"deployed",
	"superseded",
	"ignored",
	"rejected",
	"duplicate",
	"rate_limited",
	"failed",
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export interface DeliveryView {
	id: string;
	provider: string;
	event: string | null;
	branch: string | null;
	commitSha: string | null;
	status: DeliveryStatus;
	/** Reason code (see webhookReasonLabels). */
	reason: string | null;
	deploymentId: string | null;
	createdAt: Date;
}

export interface GitAppView {
	source: GitSource & { host: string };
	build: BuildSettings;
	runtime: RuntimeSettings;
	keepImages: number;
	buildSecretNames: string[];
	credential: GitCredentialView | null;
	detectedBuilder: BuilderId | null;
	webhook: {
		enabled: boolean;
		/** Path of the hook URL (the panel's origin is prepended in the UI). */
		path: string;
		providers: string[];
	};
	defaults: GitDefaults;
}
