import { eq } from "drizzle-orm";
import { appBaseUrl, getConfig } from "#/config/server.ts";
import { db } from "#/db/index.ts";
import { settings } from "#/db/schema/settings.ts";
import { createSetupTokens } from "#/server/services/setup-token.ts";
import { decrypt, encrypt } from "#/utils/crypto.ts";

/**
 * Database wiring of the setup token (`#/server/services/setup-token.ts`).
 * A generated token lives in the settings table (not a UI setting),
 * encrypted with ENCRYPTION_KEY like secret settings: it survives restarts
 * and container recreation, sits next to the users it guards (the row is
 * deleted in the transaction that creates the first account), and needs no
 * writable file in development. Never sent to the UI.
 */
const SETUP_TOKEN_KEY = "setup.token";

async function load(): Promise<string | null> {
	const [row] = await db
		.select({ value: settings.value })
		.from(settings)
		.where(eq(settings.key, SETUP_TOKEN_KEY))
		.limit(1);
	const encrypted = (row?.value as { encrypted?: unknown } | undefined)
		?.encrypted;
	if (typeof encrypted !== "string") return null;
	try {
		return decrypt(encrypted);
	} catch {
		// ENCRYPTION_KEY changed before the first account: a new token.
		return null;
	}
}

async function save(token: string): Promise<void> {
	const value = { encrypted: encrypt(token) };
	await db
		.insert(settings)
		.values({ key: SETUP_TOKEN_KEY, value, updatedAt: new Date() })
		.onConflictDoUpdate({
			target: settings.key,
			set: { value, updatedAt: new Date() },
		});
}

/** Removes the generated token (inside the first account's transaction). */
export async function clearSetupToken(
	tx: Pick<typeof db, "delete"> = db,
): Promise<void> {
	await tx.delete(settings).where(eq(settings.key, SETUP_TOKEN_KEY));
	setupTokens.forget();
}

function panelUrl(): string {
	const config = getConfig();
	return appBaseUrl(config) ?? `http://<server-ip>:${config.PANEL_PORT}`;
}

export const setupTokens = createSetupTokens({
	envToken: () => getConfig().SETUP_TOKEN,
	accountExists: async () => !!(await db.query.users.findFirst()),
	load,
	save,
	clear: () => clearSetupToken(),
	panelUrl,
	log: (line) => console.info(`[setup] ${line}`),
});

/** Whether `given` is the setup token (false once an account exists). */
export function setupTokenMatches(
	given: string | null | undefined,
): Promise<boolean> {
	return setupTokens.matches(given);
}
