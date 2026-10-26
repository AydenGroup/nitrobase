import { internalError } from "./plain-errors";

const PLACEHOLDERS = new Set([
	"change-me-32-bytes-min-length-xx",
	"change-me",
	"changeme",
	"secret",
]);

/** Throw with a clear message unless `name` holds a strong secret. */
export function requireSecret(name: "ENCRYPTION_KEY" | "SESSION_SECRET") {
	const value = process.env[name];
	if (!value || value.length < 32 || PLACEHOLDERS.has(value)) {
		throw internalError(
			`${name} must be set to a random value of at least 32 characters (generate one with: openssl rand -base64 32)`,
		);
	}
	return value;
}

/**
 * Keys used before the last rotation (`ENCRYPTION_KEY_PREVIOUS`, comma
 * separated, newest first). Decryption falls back to them, so values or
 * backup archives (`env.enc`) written under an old key stay readable. Keep
 * an old key here until every backup made with it has aged out.
 */
export function previousSecrets(): string[] {
	return (process.env.ENCRYPTION_KEY_PREVIOUS ?? "")
		.split(",")
		.map((value) => value.trim())
		.filter((value) => value.length > 0);
}

/** Fail fast at startup when required configuration is missing. */
export function assertServerEnv(): void {
	const problems: string[] = [];
	if (!process.env.DATABASE_URL) problems.push("DATABASE_URL must be set");
	for (const name of ["ENCRYPTION_KEY", "SESSION_SECRET"] as const) {
		try {
			requireSecret(name);
		} catch (error) {
			problems.push((error as Error).message);
		}
	}
	if (previousSecrets().some((value) => value.length < 32)) {
		problems.push(
			"ENCRYPTION_KEY_PREVIOUS entries must each be at least 32 characters",
		);
	}
	if (problems.length) {
		throw internalError(`Invalid configuration:\n- ${problems.join("\n- ")}`);
	}
}

/** Session cookies are `Secure` only when the app is served over HTTPS. */
export function isSecureAppUrl(appUrl = process.env.APP_URL): boolean {
	return !!appUrl && appUrl.trim().toLowerCase().startsWith("https://");
}
