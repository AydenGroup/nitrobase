import type { UpdateKind } from "#/libs/semver.ts";

/**
 * App update rules (pure, client-safe): which updates a policy applies by
 * itself, when the maintenance window is open, and how a failed update is
 * rolled back.
 */

/** Per-app policy: notify only (default) or apply patch / minor releases. */
export const APP_UPDATE_POLICIES = ["notify", "patch", "minor"] as const;
export type AppUpdatePolicy = (typeof APP_UPDATE_POLICIES)[number];

/**
 * Distance of an available update: semver kinds, a new commit of a branch
 * or commit-based template (never applied automatically), or versions
 * that do not parse ("unknown": newer by name, notify only).
 */
export type AppUpdateKind = UpdateKind | "commit" | "unknown";

/** Whether `policy` applies an update of `kind` without asking. */
export function autoUpdateAllowed(
	policy: AppUpdatePolicy,
	kind: AppUpdateKind | null,
): boolean {
	if (policy === "notify" || !kind) return false;
	if (kind === "patch") return true;
	return policy === "minor" && kind === "minor";
}

/** The maintenance window started at `start` is open at `now`. */
export function windowOpen(start: Date, now: Date, minutes: number): boolean {
	const elapsed = now.getTime() - start.getTime();
	return elapsed >= 0 && elapsed < minutes * 60_000;
}

/**
 * How a failed update is undone (template.toml `[updates].rollback`,
 * database engines in their registry):
 * - `redeploy`: deploy the previous version / commit again (files, env and
 *   images of the old version; data untouched),
 * - `restore`: restore the backup taken before the update (the new version
 *   may have migrated data irreversibly),
 * - `manual`: leave it to the owner (logged and notified).
 */
export const ROLLBACK_MODES = ["redeploy", "restore", "manual"] as const;
export type RollbackMode = (typeof ROLLBACK_MODES)[number];

export type RollbackDecision =
	/** The running version was never replaced (e.g. the build failed). */
	| { action: "none" }
	| { action: "redeploy" }
	| { action: "restore" }
	| { action: "manual"; reason: "mode" | "no_backup" };

export function decideRollback(input: {
	mode: RollbackMode;
	/** The update reached the app (files/containers changed: status error). */
	appTouched: boolean;
	/** A backup of this update's job exists. */
	backupTaken: boolean;
}): RollbackDecision {
	if (!input.appTouched) return { action: "none" };
	if (input.mode === "manual") return { action: "manual", reason: "mode" };
	if (input.mode === "restore") {
		// Redeploying the old version onto migrated data could corrupt it:
		// without the backup, a human decides.
		return input.backupTaken
			? { action: "restore" }
			: { action: "manual", reason: "no_backup" };
	}
	return { action: "redeploy" };
}

/** Result of one update, as recorded on the app (and in bulk summaries). */
const APP_UPDATE_RESULTS = [
	"succeeded",
	"rolled_back",
	"failed",
	"skipped",
] as const;
export type AppUpdateResult = (typeof APP_UPDATE_RESULTS)[number];
