import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * One-time setup token: while no account exists, the first sign-up and the
 * first-run restore need it, so whoever reaches a fresh panel first cannot
 * take it over. SETUP_TOKEN (the installer writes it to `.env`) wins;
 * without it the panel generates one, keeps it until the first account
 * exists and prints it to its logs (`docker compose logs app`). It means
 * nothing once an account exists (both paths are closed then).
 *
 * The logic is pure; storage, logging and the account check are injected
 * (the database wiring is `#/features/setup/setup-token.server.ts`).
 */

/** Random bytes of a generated token (32 hex characters, as the installer's). */
const TOKEN_BYTES = 16;

/** Marker searched for in the logs (README: `grep "Setup token"`). */
export const SETUP_TOKEN_LOG_LABEL = "Setup token";

export interface SetupTokenDeps {
	/** SETUP_TOKEN from the environment (wins over a generated one). */
	envToken: () => string | undefined;
	accountExists: () => Promise<boolean>;
	/** The generated token kept until the first account exists. */
	load: () => Promise<string | null>;
	save: (token: string) => Promise<void>;
	clear: () => Promise<void>;
	/** Where to create the first account (shown in the log line). */
	panelUrl: () => string;
	/** Writes one line to the panel logs. */
	print: (line: string) => void;
}

export function generateSetupToken(): string {
	return randomBytes(TOKEN_BYTES).toString("hex");
}

const digest = (value: string) => createHash("sha256").update(value).digest();

/** Constant-time comparison (both sides hashed: equal lengths). */
export function tokensEqual(
	given: string | null | undefined,
	expected: string,
): boolean {
	if (typeof given !== "string" || given.trim().length === 0) return false;
	return timingSafeEqual(digest(given.trim()), digest(expected));
}

export function createSetupTokens(deps: SetupTokenDeps) {
	/** The stored/generated token of this process (one instance only). */
	let pending: Promise<string> | null = null;
	let announced = false;

	function announce(token: string): void {
		if (announced) return;
		announced = true;
		deps.print(
			`${SETUP_TOKEN_LOG_LABEL}: ${token} (open ${deps.panelUrl()} to create the first account)`,
		);
	}

	function generated(): Promise<string> {
		pending ??= (async () => {
			const stored = await deps.load();
			if (stored) return stored;
			const token = generateSetupToken();
			await deps.save(token);
			return token;
		})().catch((error) => {
			pending = null;
			throw error;
		});
		return pending;
	}

	/** The token the first account needs; null once an account exists. */
	async function current(): Promise<string | null> {
		const env = deps.envToken();
		if (env) return env;
		if (await deps.accountExists()) return null;
		const token = await generated();
		announce(token);
		return token;
	}

	return {
		current,

		/** Whether `given` is the setup token (false once an account exists). */
		async matches(given: string | null | undefined): Promise<boolean> {
			const expected = await current();
			return expected !== null && tokensEqual(given, expected);
		},

		/**
		 * Boot: drop a leftover token once an account exists, else make sure
		 * one exists and print it (a SETUP_TOKEN value is never logged).
		 */
		async boot(): Promise<void> {
			if (await deps.accountExists()) {
				pending = null;
				await deps.clear();
				return;
			}
			if (deps.envToken()) {
				if (announced) return;
				announced = true;
				deps.print(
					`${SETUP_TOKEN_LOG_LABEL}: SETUP_TOKEN of the install's .env (open ${deps.panelUrl()} to create the first account)`,
				);
				return;
			}
			await current();
		},

		/** The first account exists: the generated token is spent. */
		forget(): void {
			pending = null;
		},
	};
}

export type SetupTokens = ReturnType<typeof createSetupTokens>;
