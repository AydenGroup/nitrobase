import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { z } from "zod";
import { APP_ID } from "#/config/shared.ts";
import type { DestinationTestStep } from "#/db/schema/backups.ts";
import { errorCodes } from "#/libs/error-codes.ts";
import {
	crossField,
	field,
	isPrivateHost,
	type SchemaField,
	schemaFields,
	secretFieldNames,
	validation,
} from "./schema-fields";

/**
 * Backup destination drivers. Adding one = one entry here: a zod config
 * schema (fields carry form metadata via `.meta()`) and how it maps to an
 * rclone remote. Client-safe (no secrets, no server imports).
 */

export interface RcloneRemote {
	/** `[remote]` section of rclone.conf. */
	section: Record<string, string>;
	/** Path inside the remote that archives are stored under. */
	base: string;
	/** Host directory mounted into the rclone container (local driver). */
	mount?: { host: string; container: string };
}

interface DriverEnv {
	/** Server directory of the `local` driver (config BACKUP_LOCAL_ROOT). */
	localRoot: string;
}

/** What a destination can do; callers check these, never a driver type. */
export interface DestinationCapabilities {
	/**
	 * Archives are stored on the server that made them: only that server
	 * reads them back (restores, verification, downloads, moves go through
	 * it) and they are lost with it (not an off-site copy).
	 */
	onServer: boolean;
}

export interface DestinationDriver<S extends z.ZodObject = z.ZodObject> {
	type: string;
	label: MessageDescriptor;
	description: MessageDescriptor;
	schema: S;
	capabilities: DestinationCapabilities;
	toRclone(config: z.infer<S>, env: DriverEnv): RcloneRemote;
}

/** Off-site storage reachable from any server (the usual remote). */
const remoteStorage: DestinationCapabilities = { onServer: false };

/** One path segment chain: `a/b-c`, no dots-only segments or `..`. */
const relativePath = z
	.string()
	.trim()
	.regex(
		/^([A-Za-z0-9_][A-Za-z0-9_.-]*)(\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/,
		validation(msg({ id: "Letters, digits, _ . - and /" })),
	)
	.or(z.literal(""));
const bucket = z
	.string()
	.trim()
	.regex(
		/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/,
		validation(msg({ id: "Invalid bucket name" })),
	);
/** No control characters: values end up in rclone.conf lines. */
const line = z
	.string()
	.trim()
	.min(1)
	.max(512)
	.refine(
		(value) => !/[\r\n\0]/.test(value),
		validation(msg({ id: "Single line only" })),
	);

const joinPath = (...parts: string[]) =>
	parts.filter((part) => part !== "").join("/");

const localSchema = z.object({
	path: relativePath.default("").meta(
		field({
			label: msg({ id: "Folder" }),
			help: msg({
				id: "Inside the server's backup root. Leave empty to use the root.",
			}),
			placeholder: "apps",
		}),
	),
});

const s3Fields = {
	bucket: bucket.meta(field({ label: msg({ id: "Bucket" }) })),
	prefix: relativePath.default("").meta(
		field({
			label: msg({ id: "Prefix" }),
			help: msg({ id: "Folder inside the bucket (optional)." }),
			placeholder: APP_ID,
		}),
	),
	accessKeyId: line.meta(field({ label: msg({ id: "Access key ID" }) })),
	secretAccessKey: line.meta(
		field({ label: msg({ id: "Secret access key" }), secret: true }),
	),
};

const s3Schema = z
	.object({
		endpoint: z
			.url()
			.refine(
				(value) => /^https?:\/\//.test(value),
				validation(msg({ id: "An http(s) URL" })),
			)
			.meta(
				field({
					label: msg({ id: "Endpoint" }),
					placeholder: "https://s3.eu-central-1.amazonaws.com",
				}),
			),
		region: z
			.string()
			.trim()
			.regex(/^[a-z0-9-]*$/, validation(msg({ id: "Invalid region" })))
			.default("")
			.meta(
				field({
					label: msg({ id: "Region" }),
					placeholder: "us-east-1",
				}),
			),
		...s3Fields,
		pathStyle: z
			.boolean()
			.default(true)
			.meta(
				field({
					label: msg({ id: "Path-style URLs" }),
					help: msg({ id: "Required by MinIO and most self-hosted S3." }),
				}),
			),
		privateEndpoint: z
			.boolean()
			.default(false)
			.meta(
				field({
					label: msg({ id: "Private or plain-HTTP endpoint" }),
					help: msg({
						id: "Allow http:// and private, loopback or link-local addresses (e.g. MinIO on your network). Off: https to a public host only.",
					}),
				}),
			),
	})
	.superRefine((config, ctx) => {
		if (config.privateEndpoint) return;
		let url: URL;
		try {
			url = new URL(config.endpoint);
		} catch {
			return; // reported by the endpoint field itself
		}
		if (url.protocol !== "https:" || isPrivateHost(url.hostname)) {
			ctx.addIssue({
				code: "custom",
				path: ["endpoint"],
				message: validation(
					msg({
						id: "Use https to a public host, or enable private or plain-HTTP endpoint",
					}),
				),
			});
		}
	}, crossField);

const r2Schema = z.object({
	accountId: z
		.string()
		.trim()
		.regex(/^[a-f0-9]{32}$/, validation(msg({ id: "32 hex characters" })))
		.meta(field({ label: msg({ id: "Cloudflare account ID" }) })),
	...s3Fields,
});

const b2Schema = z.object({
	bucket: z
		.string()
		.trim()
		.regex(
			/^[A-Za-z0-9-]{6,50}$/,
			validation(msg({ id: "Invalid bucket name" })),
		)
		.meta(field({ label: msg({ id: "Bucket" }) })),
	prefix: s3Fields.prefix,
	keyId: line.meta(field({ label: msg({ id: "Application key ID" }) })),
	applicationKey: line.meta(
		field({ label: msg({ id: "Application key" }), secret: true }),
	),
});

/** Cloudflare R2 S3 endpoint for an account. */
const R2_ENDPOINT = (accountId: string) =>
	`https://${accountId}.r2.cloudflarestorage.com`;

export const destinationDrivers: DestinationDriver[] = [
	{
		type: "local",
		capabilities: { onServer: true },
		label: msg({ id: "Server folder" }),
		description: msg({
			id: "A folder on the app's server. Simple, but lost with the server: use it with an off-site copy.",
		}),
		schema: localSchema,
		toRclone: (config: z.infer<typeof localSchema>, env) => ({
			section: { type: "local" },
			base: joinPath("/backups", config.path),
			mount: { host: env.localRoot, container: "/backups" },
		}),
	} satisfies DestinationDriver<typeof localSchema> as DestinationDriver,
	{
		type: "s3",
		capabilities: remoteStorage,
		label: msg({ id: "S3-compatible" }),
		description: msg({
			id: "Amazon S3, MinIO, Wasabi, DigitalOcean Spaces and other S3 APIs.",
		}),
		schema: s3Schema,
		toRclone: (config: z.infer<typeof s3Schema>) => ({
			section: {
				type: "s3",
				provider: "Other",
				env_auth: "false",
				access_key_id: config.accessKeyId,
				secret_access_key: config.secretAccessKey,
				endpoint: config.endpoint,
				...(config.region ? { region: config.region } : {}),
				force_path_style: String(config.pathStyle),
				no_check_bucket: "true",
			},
			base: joinPath(config.bucket, config.prefix),
		}),
	} satisfies DestinationDriver<typeof s3Schema> as DestinationDriver,
	{
		type: "r2",
		capabilities: remoteStorage,
		label: msg({ id: "Cloudflare R2" }),
		description: msg({ id: "S3-compatible storage without egress fees." }),
		schema: r2Schema,
		toRclone: (config: z.infer<typeof r2Schema>) => ({
			section: {
				type: "s3",
				provider: "Cloudflare",
				env_auth: "false",
				access_key_id: config.accessKeyId,
				secret_access_key: config.secretAccessKey,
				endpoint: R2_ENDPOINT(config.accountId),
				region: "auto",
				no_check_bucket: "true",
			},
			base: joinPath(config.bucket, config.prefix),
		}),
	} satisfies DestinationDriver<typeof r2Schema> as DestinationDriver,
	{
		type: "b2",
		capabilities: remoteStorage,
		label: msg({ id: "Backblaze B2" }),
		description: msg({ id: "Backblaze B2 native API." }),
		schema: b2Schema,
		toRclone: (config: z.infer<typeof b2Schema>) => ({
			section: {
				type: "b2",
				account: config.keyId,
				key: config.applicationKey,
			},
			base: joinPath(config.bucket, config.prefix),
		}),
	} satisfies DestinationDriver<typeof b2Schema> as DestinationDriver,
];

export function getDestinationDriver(type: string): DestinationDriver | null {
	return destinationDrivers.find((driver) => driver.type === type) ?? null;
}

/** Capabilities of a destination type (unknown types: remote storage). */
export function destinationCapabilities(type: string): DestinationCapabilities {
	return getDestinationDriver(type)?.capabilities ?? remoteStorage;
}

export type DriverField = SchemaField;

/** Form fields of a driver, from its schema and `.meta()`. */
export function driverFields(driver: DestinationDriver): DriverField[] {
	return schemaFields(driver.schema);
}

/** Names of the driver's secret fields. */
export function secretFields(driver: DestinationDriver): string[] {
	return secretFieldNames(driver.schema);
}

/** Labels of the destination test steps. */
export const destinationTestSteps = {
	write: msg({ id: "Write a test file" }),
	read: msg({ id: "Read it back" }),
	delete: msg({ id: "Delete it" }),
} satisfies Record<DestinationTestStep, MessageDescriptor>;

/** Destination test failure kinds (server: `summarizeRcloneError`). */
export const rcloneErrorLabels: Record<string, MessageDescriptor> = {
	auth: errorCodes.RCLONE_AUTH,
	not_found: errorCodes.RCLONE_NOT_FOUND,
	permission: errorCodes.RCLONE_PERMISSION,
	network: errorCodes.RCLONE_NETWORK,
	tls: errorCodes.RCLONE_TLS,
	unknown: errorCodes.RCLONE_UNKNOWN,
};
