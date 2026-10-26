import { z } from "zod";
import type { ErrorInfo } from "#/libs/coded.ts";
import type { InstallProblem } from "#/server/services/upgrade/install.ts";
import type {
	ReleaseChannel,
	ReleaseInfo,
} from "#/server/services/upgrade/releases.ts";
import type {
	UpgradeOutcome,
	UpgradePhase,
} from "#/server/services/upgrade/state-machine.ts";

export type { UpgradeOutcome };

/** Result of the Nitrobase release check. */
export interface InstanceUpdateStatus {
	/** This build's version. */
	current: string;
	channel: ReleaseChannel;
	/** Repository checked (RELEASE_REPO). */
	repo: string;
	check: "ok" | "disabled" | "error";
	latest: ReleaseInfo | null;
	available: boolean;
	/** Why the check failed (coded; GitHub rate limit included). */
	error: ErrorInfo | null;
}

/** Why "Upgrade" is disabled (besides the install problems). */
export type UpgradeBlocker =
	| InstallProblem
	| "paused"
	| "upgrading"
	| "no_update";

export interface UpgradeOverview {
	update: InstanceUpdateStatus;
	/** null: the in-panel upgrade can run. */
	blocker: UpgradeBlocker | null;
	install: {
		dir: string;
		image: string;
	} | null;
	/** Running or last upgrade (kept until the next one starts). */
	last: {
		deploymentId: string;
		from: string;
		to: string;
		phase: UpgradePhase;
		outcome: UpgradeOutcome | null;
		startedAt: string;
	} | null;
	/** "Install on a VPS" guide. */
	installGuideUrl: string;
}

export const StartUpgradeSchema = z.object({
	/** Image tag of the release (`1.2.3`). */
	version: z.string().regex(/^[\w][\w.-]{0,127}$/),
	/** Mandatory self-backup before the switch. */
	destinationId: z.guid(),
	/** Server whose rclone uploads the backup (default: first Ready one). */
	serverId: z.guid().optional(),
});
export type StartUpgradeInput = z.infer<typeof StartUpgradeSchema>;
