import type { I18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";

/**
 * Name shown for a team whose name was never set: the personal team created
 * at sign-up stores `null` and is shown in the reader's language. A rename
 * stores the user's text.
 */
export const defaultTeamName = msg({ id: "Personal" });

export function teamDisplayName(
	i18n: I18n,
	name: string | null | undefined,
): string {
	return name ?? i18n._(defaultTeamName);
}
