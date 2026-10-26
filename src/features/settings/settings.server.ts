import { eq } from "drizzle-orm";
import {
	type SettingKey,
	type SettingValue,
	type SettingView,
	settingKeys,
	settingsRegistry,
} from "#/config/settings.ts";
import { db } from "#/db/index.ts";
import { domains } from "#/db/schema/apps.ts";
import { settings } from "#/db/schema/settings.ts";
import type { Actor } from "#/features/auth/access.ts";
import { audit } from "#/server/services/audit.ts";
import { decrypt, encrypt } from "#/utils/crypto.ts";
import { AppError } from "#/utils/error.ts";

/** Server-side checks run before a setting is stored. */
const settingGuards: Partial<
	Record<SettingKey, (value: unknown) => Promise<void>>
> = {
	// The panel host must not collide with a routed app domain (Traefik
	// would pick one of the two routers arbitrarily).
	"instance.panelDomain": async (value) => {
		const host = String(value);
		const [taken] = await db
			.select({ id: domains.id })
			.from(domains)
			.where(eq(domains.host, host))
			.limit(1);
		if (taken) throw new AppError("DOMAIN_TAKEN", { host });
	},
};

type Stored = { plain: unknown } | { encrypted: string };

function decode(key: SettingKey, stored: Stored): unknown {
	const definition = settingsRegistry[key];
	if ("encrypted" in stored) return JSON.parse(decrypt(stored.encrypted));
	return definition.secret ? undefined : stored.plain;
}

/** Typed setting value: DB first, then the env fallback, else undefined. */
export async function getSetting<K extends SettingKey>(
	key: K,
): Promise<SettingValue<K> | undefined> {
	const [row] = await db
		.select()
		.from(settings)
		.where(eq(settings.key, key))
		.limit(1);
	if (row) {
		const parsed = settingsRegistry[key].schema.safeParse(
			decode(key, row.value as Stored),
		);
		if (parsed.success) return parsed.data as SettingValue<K>;
	}
	const definition = settingsRegistry[key] as { envFallback?: string };
	const fromEnv = definition.envFallback
		? process.env[definition.envFallback]
		: undefined;
	return (fromEnv || undefined) as SettingValue<K> | undefined;
}

export async function listSettings(): Promise<SettingView[]> {
	const rows = await db.select().from(settings);
	const byKey = new Map(rows.map((row) => [row.key, row.value as Stored]));
	return settingKeys.map((key) => {
		const definition = settingsRegistry[key] as {
			secret: boolean;
			envFallback?: string;
		};
		const stored = byKey.get(key);
		const fromEnv =
			!stored &&
			!!definition.envFallback &&
			!!process.env[definition.envFallback];
		return {
			key,
			secret: definition.secret,
			value:
				definition.secret || !stored ? null : String(decode(key, stored) ?? ""),
			isSet: !!stored || fromEnv,
			fromEnv,
		};
	});
}

/** Validate and store a setting; `null` clears it. */
export async function setSetting(
	actor: Actor,
	key: SettingKey,
	value: unknown,
): Promise<void> {
	const definition = settingsRegistry[key];
	if (value === null || value === "") {
		await db.delete(settings).where(eq(settings.key, key));
	} else {
		const parsed = definition.schema.safeParse(value);
		if (!parsed.success) {
			throw new AppError("SETTING_INVALID", {
				detail: parsed.error.issues[0]?.message ?? "",
			});
		}
		await settingGuards[key]?.(parsed.data);
		const stored: Stored = definition.secret
			? { encrypted: encrypt(JSON.stringify(parsed.data)) }
			: { plain: parsed.data };
		await db
			.insert(settings)
			.values({ key, value: stored, updatedAt: new Date() })
			.onConflictDoUpdate({
				target: settings.key,
				set: { value: stored, updatedAt: new Date() },
			});
	}
	audit({
		actor,
		action: "settings.update",
		// The setting's name is not secret; only a secret setting's value is.
		meta: {
			setting: key,
			cleared: value === null || value === "",
			...(definition.secret || value === null || value === ""
				? {}
				: { new: String(value) }),
		},
	});
}
