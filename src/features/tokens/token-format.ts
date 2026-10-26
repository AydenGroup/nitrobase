/**
 * API token format (pure): `nbk_<prefix>_<secret>`, `<prefix>` 12 random
 * lowercase characters (finds the row), `<secret>` 32 random bytes in
 * base64url. Only sha256 of the whole token is stored.
 */
export const TOKEN_PREFIX = "nbk_";

const TOKEN_PATTERN = new RegExp(
	`^${TOKEN_PREFIX}([a-z0-9]{12})_[A-Za-z0-9_-]{43}$`,
);
const PUBLIC_PART = new RegExp(`^${TOKEN_PREFIX}[a-z0-9]{12}_`);

/** Random row prefix of a well-formed token, else null. */
export const tokenRowPrefix = (bearer: string): string | null =>
	bearer.match(TOKEN_PATTERN)?.[1] ?? null;

/** Public part of a presented token (brand + random prefix), else null. */
export const tokenPublicPart = (bearer: string): string | null =>
	bearer.match(PUBLIC_PART)?.[0] ?? null;
