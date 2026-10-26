import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { z } from "zod";
import { branded } from "#/libs/brand.ts";

/**
 * Instance settings registry. Add a setting = add an entry; values are
 * stored in the `settings` table (secrets encrypted) and validated with the
 * entry's schema on write. Readable from the client for labels/forms only;
 * secret values never leave the server (the client sees `isSet`).
 */
export interface SettingDefinition<T> {
	schema: z.ZodType<T>;
	secret: boolean;
	label: MessageDescriptor;
	description: MessageDescriptor;
	/** Env variable used when the setting is not stored. */
	envFallback?: string;
}

const hostname = z
	.string()
	.trim()
	.toLowerCase()
	.regex(
		/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/,
		"Enter a domain name like panel.example.com",
	);

export const settingsRegistry = {
	"github.token": {
		schema: z.string().trim().min(10).max(255),
		secret: true,
		label: msg({ id: "GitHub token" }),
		description: msg({
			id: "Personal access token (no scopes needed) used to list template versions with a higher rate limit.",
		}),
		envFallback: "GITHUB_TOKEN",
	} satisfies SettingDefinition<string>,
	"instance.panelDomain": {
		schema: hostname,
		secret: false,
		label: msg({ id: "Panel domain" }),
		description: branded(
			msg({
				id: "Serve this {appName} panel through Traefik with a Let's Encrypt certificate.",
			}),
		),
		// Set by the installer's --domain.
		envFallback: "PANEL_DOMAIN",
	} satisfies SettingDefinition<string>,
} as const;

export type SettingKey = keyof typeof settingsRegistry;
export type SettingValue<K extends SettingKey> = z.infer<
	(typeof settingsRegistry)[K]["schema"]
>;

export const settingKeys = Object.keys(settingsRegistry) as SettingKey[];

export const SettingKeySchema = z.enum(
	settingKeys as [SettingKey, ...SettingKey[]],
);

export interface SettingView {
	key: SettingKey;
	secret: boolean;
	/** Non-secret value, or null. */
	value: string | null;
	isSet: boolean;
	/** Set through the environment instead of the database. */
	fromEnv: boolean;
}
