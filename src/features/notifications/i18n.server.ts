import type { I18n } from "@lingui/core";
import { getConfig } from "#/config/server.ts";
import { serverI18n } from "#/server/services/i18n.ts";

/** Lingui instance for server-rendered notification texts (NOTIFY_LOCALE). */
export function notificationI18n(): I18n {
	return serverI18n(getConfig().NOTIFY_LOCALE);
}
