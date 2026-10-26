import type { MessageDescriptor } from "@lingui/core";
import { APP_NAME } from "#/config/shared.ts";

/**
 * A message mentioning the product: its `{appName}` placeholder is filled
 * with the brand (`APP_NAME`), so renaming the product touches no catalog.
 * Registries rendered through coded params (errors, log events, job titles,
 * notifications, check details) get `appName` there instead.
 */
export function branded(message: MessageDescriptor): MessageDescriptor {
	return { ...message, values: { appName: APP_NAME, ...message.values } };
}
