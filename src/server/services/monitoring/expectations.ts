import { lookup } from "#/config/labels.ts";
import { appStatuses } from "#/config/status.ts";
import type { AppExpectation } from "./alert-rules";

/** An app's row as read when alerts are evaluated (after the tick). */
export interface AppStateRow {
	id: string;
	status: string;
	/** App inputs `stoppedServices` (stopped one by one by the owner). */
	stoppedServices: string[] | null;
}

/**
 * What the alert rules expect of each app, from its row read right
 * before they run (not the one read before the tick's remote command: a
 * Stop during the command would count as an unexpected exit) and the
 * jobs holding it now.
 */
export function appExpectations(
	rows: readonly AppStateRow[],
	oneShot: ReadonlyMap<string, ReadonlySet<string>>,
	isBusy: (appId: string) => boolean,
): Map<string, AppExpectation> {
	return new Map(
		rows.map((row) => [
			row.id,
			{
				live: !!lookup(appStatuses, row.status)?.live,
				busy: isBusy(row.id),
				oneShot: oneShot.get(row.id) ?? new Set(),
				stopped: new Set(row.stoppedServices ?? []),
			},
		]),
	);
}
