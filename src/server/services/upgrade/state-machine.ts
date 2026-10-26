import { resourceName } from "#/config/identifiers.ts";
import { internalError } from "#/utils/error.ts";
/**
 * Panel upgrade orchestration (pure). The panel cannot replace its own
 * container, so the upgrade is split between the panel job and a
 * short-lived updater container (see updater-script.ts):
 *
 *   panel:   preflight → backup → pull → handoff
 *   updater: switching → health → succeeded
 *                               ↘ rolling_back → rolled_back | failed
 *
 * The updater prints `@@nitrobase-upgrade <phase>` markers; whichever panel
 * is alive (the old one if the switch never happened, else the new or the
 * restored one) follows them, appends the updater's log to the job and
 * finishes the job from the updater's exit code.
 */
export const upgradePhases = [
	"preflight",
	"backup",
	"pull",
	"handoff",
	"switching",
	"health",
	"rolling_back",
	"succeeded",
	"rolled_back",
	"failed",
] as const;

export type UpgradePhase = (typeof upgradePhases)[number];

export type UpgradeOutcome = "succeeded" | "rolled_back" | "failed";

const transitions: Record<UpgradePhase, readonly UpgradePhase[]> = {
	preflight: ["backup", "failed"],
	// A failed backup or pull ends the upgrade before anything changed.
	backup: ["pull", "failed"],
	pull: ["handoff", "failed"],
	// The updater could not start: nothing changed either.
	handoff: ["switching", "failed"],
	// `compose up` of the new image failed: back to the old image.
	switching: ["health", "rolling_back", "failed"],
	health: ["succeeded", "rolling_back"],
	rolling_back: ["rolled_back", "failed"],
	succeeded: [],
	rolled_back: [],
	failed: [],
};

export function canTransition(from: UpgradePhase, to: UpgradePhase): boolean {
	return transitions[from].includes(to);
}

/** Next phase, or an error for a transition the design does not allow. */
export function transition(from: UpgradePhase, to: UpgradePhase): UpgradePhase {
	if (!canTransition(from, to)) {
		throw internalError(`Invalid upgrade transition ${from} → ${to}`);
	}
	return to;
}

export function isTerminal(phase: UpgradePhase): phase is UpgradeOutcome {
	return transitions[phase].length === 0;
}

/** Phase marker the updater prints (`@@<prefix>-upgrade <phase>`). */
export const UPGRADE_MARKER = `@@${resourceName("upgrade")}`;

const PHASE_LINE = new RegExp(`^${UPGRADE_MARKER} ([a-z_]+)\\s*$`);

/** Phase announced by an updater log line, or null for a normal line. */
export function phaseOfLine(line: string): UpgradePhase | null {
	const match = PHASE_LINE.exec(line.trim());
	const phase = match?.[1] as UpgradePhase | undefined;
	return phase && (upgradePhases as readonly string[]).includes(phase)
		? phase
		: null;
}

/** Updater exit codes (see updater-script.ts). */
export const UPDATER_EXIT = {
	succeeded: 0,
	rolledBack: 10,
	rollbackFailed: 11,
	/** Bad input / precondition: nothing was changed. */
	refused: 2,
} as const;

/** Outcome of a finished updater from its exit code and last phase. */
export function outcomeOfUpdater(
	exitCode: number,
	lastPhase: UpgradePhase | null,
): UpgradeOutcome {
	if (exitCode === UPDATER_EXIT.succeeded && lastPhase === "succeeded") {
		return "succeeded";
	}
	if (exitCode === UPDATER_EXIT.rolledBack) return "rolled_back";
	if (exitCode === UPDATER_EXIT.refused && lastPhase !== "switching") {
		// Refused before touching anything: the old version still runs.
		return "rolled_back";
	}
	return "failed";
}

/**
 * Replay the updater's markers from `start` (the panel's last phase):
 * the phase the upgrade is in now. Out-of-order markers are ignored (a
 * marker never moves the upgrade backwards or past a terminal phase).
 */
export function replayPhases(
	start: UpgradePhase,
	lines: string[],
): UpgradePhase {
	let phase = start;
	for (const line of lines) {
		const next = phaseOfLine(line);
		if (next && canTransition(phase, next)) phase = next;
	}
	return phase;
}
