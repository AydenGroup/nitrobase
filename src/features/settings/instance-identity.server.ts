import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { getConfig } from "#/config/server.ts";
import { APP_NAME } from "#/config/shared.ts";
import { db } from "#/db/index.ts";
import { settings } from "#/db/schema/settings.ts";
import {
	currentInstanceId,
	decideIdentity,
	instancePauseReason,
	type PauseReason,
	setInstanceId,
	setInstancePaused,
} from "#/server/services/instance-state.ts";
import { internalError } from "#/utils/error.ts";

/** Settings row holding the database's instance id (not a UI setting). */
const IDENTITY_KEY = "instance.identity";

function markerPath(): string {
	return path.resolve(process.cwd(), getConfig().INSTANCE_MARKER_FILE);
}

async function readMarker(): Promise<string | null> {
	const fromEnv = getConfig().INSTANCE_ID;
	if (fromEnv) return fromEnv;
	try {
		return (await readFile(markerPath(), "utf8")).trim() || null;
	} catch {
		return null;
	}
}

async function writeMarker(id: string): Promise<void> {
	if (getConfig().INSTANCE_ID) return; // the env value is the marker
	await mkdir(path.dirname(markerPath()), { recursive: true });
	await writeFile(markerPath(), `${id}\n`, { mode: 0o600 });
}

async function databaseId(): Promise<string | null> {
	const [row] = await db
		.select({ value: settings.value })
		.from(settings)
		.where(eq(settings.key, IDENTITY_KEY))
		.limit(1);
	const value = (row?.value as { plain?: unknown } | undefined)?.plain;
	return typeof value === "string" ? value : null;
}

async function storeDatabaseId(id: string): Promise<void> {
	await db
		.insert(settings)
		.values({ key: IDENTITY_KEY, value: { plain: id }, updatedAt: new Date() })
		.onConflictDoUpdate({
			target: settings.key,
			set: { value: { plain: id }, updatedAt: new Date() },
		});
}

/**
 * Boot check: returns the pause reason (and records it) when this process
 * must not start background work against the database's servers.
 */
export async function checkInstanceIdentity(): Promise<PauseReason | null> {
	const [stored, marker] = await Promise.all([databaseId(), readMarker()]);
	const verdict = decideIdentity(stored, marker);
	if (verdict.state === "adopt") {
		const id = marker ?? randomUUID();
		await storeDatabaseId(id);
		await writeMarker(id);
		setInstanceId(id);
		setInstancePaused(null);
		return null;
	}
	setInstanceId(stored);
	if (verdict.state === "match") {
		setInstancePaused(null);
		return null;
	}
	setInstancePaused(verdict.reason);
	console.warn(
		`[instance] paused: ${verdict.reason === "mismatch" ? `this database belongs to another ${APP_NAME} instance` : "no instance marker on this machine"} (restored or cloned database?). Resume from the panel banner.`,
	);
	return verdict.reason;
}

/**
 * "This database was moved — resume here": make this machine the owner
 * (the database's id follows the marker, or the marker is written) and
 * lift the pause.
 */
export async function resumeInstanceHere(): Promise<void> {
	const marker = await readMarker();
	if (marker) {
		await storeDatabaseId(marker);
		setInstanceId(marker);
	} else {
		const id = (await databaseId()) ?? randomUUID();
		await storeDatabaseId(id);
		await writeMarker(id);
		setInstanceId(id);
	}
	setInstancePaused(null);
}

export function instanceState(): { paused: PauseReason | null } {
	return { paused: instancePauseReason() };
}

/**
 * This instance's id for tagging server resources. Reads the database when
 * the boot check has not run in this process (e.g. a dev SSR module graph).
 */
export async function requireInstanceId(): Promise<string> {
	const known = currentInstanceId();
	if (known) return known;
	const stored = await databaseId();
	if (!stored) throw internalError("Instance identity is not initialised yet");
	setInstanceId(stored);
	return stored;
}
