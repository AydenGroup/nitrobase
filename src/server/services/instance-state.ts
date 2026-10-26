/**
 * Instance identity (split-brain guard). The database stores an instance
 * id; this process holds a marker (INSTANCE_ID env, else a marker file in
 * its data dir). They differ when the database was restored onto another
 * machine (self-backup disaster recovery) or cloned: then two panels could
 * drive the same servers, so this one boots *paused*: no job recovery, no
 * scheduler, no monitoring, no new jobs, until an instance admin resumes.
 * Pure decision + in-process state (single instance).
 */
export type IdentityVerdict =
	| { state: "match" }
	/** First boot (or upgrade): adopt a new id; write the marker. */
	| { state: "adopt" }
	| { state: "paused"; reason: "marker_missing" | "mismatch" };

export function decideIdentity(
	databaseId: string | null,
	marker: string | null,
): IdentityVerdict {
	if (!databaseId) return { state: "adopt" };
	if (!marker) return { state: "paused", reason: "marker_missing" };
	return marker === databaseId
		? { state: "match" }
		: { state: "paused", reason: "mismatch" };
}

export type PauseReason = "marker_missing" | "mismatch";

const globalState = globalThis as typeof globalThis & {
	__nitrobaseInstancePause?: {
		paused: PauseReason | null;
		id?: string | null;
		/** Deployment id of a running self-upgrade (no new jobs meanwhile). */
		upgrading?: string | null;
	};
};
globalState.__nitrobaseInstancePause ??= { paused: null };
const state = globalState.__nitrobaseInstancePause;

export function setInstancePaused(reason: PauseReason | null): void {
	state.paused = reason;
}

/** Why background work is paused, or null when it runs. */
export function instancePauseReason(): PauseReason | null {
	return state.paused;
}

/** Record this instance's id (the database's identity) once known. */
export function setInstanceId(id: string | null): void {
	state.id = id;
}

/**
 * This instance's id: tags every resource Nitrobase creates on servers
 * (see `#/server/services/ownership.ts`). Null before the boot check.
 */
export function currentInstanceId(): string | null {
	return state.id ?? null;
}

/** A Nitrobase self-upgrade runs (its job id), or null. */
export function setInstanceUpgrading(deploymentId: string | null): void {
	state.upgrading = deploymentId;
}

export function instanceUpgrading(): string | null {
	return state.upgrading ?? null;
}
