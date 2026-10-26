import { readFileSync } from "node:fs";
import pg from "pg";
import { getConfig } from "#/config/server.ts";
import { APP_ID } from "#/config/shared.ts";
import { TEXT_LIMITS } from "#/config/text-limits.ts";
import { clip } from "#/libs/format.ts";
import { AppError } from "#/utils/error.ts";

/**
 * The cloud database as the panel reaches it (connection test, preflight,
 * row counts): through the provider's pooler, connected to the address
 * checked by `pinnedHost`, TLS verified against the configured CA(s).
 */

/**
 * verify-full: the default, against the CA bundle. `require` (encrypted,
 * unverified) only with CLOUD_SYNC_ALLOW_UNVERIFIED_TLS; `disable` only
 * for test doubles (CLOUD_SYNC_ALLOW_PRIVATE). `missing`: no CA and no
 * opt-in, so nothing connects (CLOUD_SYNC_CA_MISSING).
 */
export type TlsMode = "verify-full" | "require" | "disable" | "missing";

export interface CloudDbTarget {
	/** Name the certificate must match (and the pgpass/service host). */
	host: string;
	/** Pinned address. */
	address: string;
	port: number;
	user: string;
	password: string;
	database: string;
	/** PEM CA bundle (instance CA file + the connection's own), or null. */
	ca: string | null;
	/** The provider's instance CA file (named when no CA is installed). */
	caFile: string;
}

const PEM_BLOCK =
	/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

/** The certificates of a PEM text (other lines, e.g. comments, dropped). */
function pemCertificates(text: string): string[] {
	return text.match(PEM_BLOCK) ?? [];
}

/**
 * CA bundle: the instance's provider CA file (missing or without a
 * certificate: none) plus a connection's own PEM; null when empty.
 */
export function caBundle(extra: string, caFile: string): string | null {
	let fromFile = "";
	if (caFile) {
		try {
			fromFile = readFileSync(caFile, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				throw new AppError("CLOUD_CA_FILE_UNREADABLE", { path: caFile });
			}
		}
	}
	const certificates = [
		...pemCertificates(fromFile),
		...pemCertificates(extra),
	];
	return certificates.length ? `${certificates.join("\n")}\n` : null;
}

export function tlsMode(
	ca: string | null,
	options: { allowPrivate: boolean; allowUnverified: boolean },
): TlsMode {
	if (ca) return "verify-full";
	if (options.allowPrivate) return "disable";
	return options.allowUnverified ? "require" : "missing";
}

/** The mode for `ca` under this instance's configuration. */
export function configuredTlsMode(ca: string | null): TlsMode {
	const config = getConfig();
	return tlsMode(ca, {
		allowPrivate: config.CLOUD_SYNC_ALLOW_PRIVATE,
		allowUnverified: config.CLOUD_SYNC_ALLOW_UNVERIFIED_TLS,
	});
}

/** No CA installed and no opt-in: tell the operator where to put it. */
export function caMissingError(caFile: string): AppError {
	return new AppError("CLOUD_SYNC_CA_MISSING", { path: caFile });
}

function sslOptions(target: CloudDbTarget, mode: TlsMode) {
	if (mode === "disable") return false;
	if (mode === "verify-full") {
		return { ca: target.ca ?? undefined, servername: target.host };
	}
	return { rejectUnauthorized: false, servername: target.host };
}

export type CloudQuery = <R extends Record<string, unknown>>(
	sql: string,
	params?: unknown[],
) => Promise<R[]>;

/** Open one connection, run `fn`, close. Errors become coded errors. */
export async function withCloudDb<T>(
	target: CloudDbTarget,
	fn: (query: CloudQuery) => Promise<T>,
): Promise<T> {
	const config = getConfig();
	const mode = configuredTlsMode(target.ca);
	if (mode === "missing") throw caMissingError(target.caFile);
	const client = new pg.Client({
		host: target.address,
		port: target.port,
		user: target.user,
		password: target.password,
		database: target.database,
		ssl: sslOptions(target, mode),
		connectionTimeoutMillis: config.CLOUD_SYNC_DB_TIMEOUT_MS,
		statement_timeout: config.CLOUD_SYNC_DB_TIMEOUT_MS,
		query_timeout: config.CLOUD_SYNC_DB_TIMEOUT_MS + 1000,
		application_name: `${APP_ID}-cloud-sync`,
	});
	// A broken connection after connect() must not crash the process.
	client.on("error", () => undefined);
	try {
		await client.connect();
		return await fn(async (sql, params) => {
			const result = await client.query(sql, params);
			return result.rows;
		});
	} catch (error) {
		if (error instanceof AppError) throw error;
		const message = error instanceof Error ? error.message : String(error);
		throw new AppError("CLOUD_DB_FAILED", {
			detail: clip(
				message.split(target.password).join("[redacted]"),
				TEXT_LIMITS.errorDetail,
			),
		});
	} finally {
		await client.end().catch(() => undefined);
	}
}
