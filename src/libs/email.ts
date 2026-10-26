import { z } from "zod";

/**
 * Canonical form of an email address: trimmed and lowercased. Accounts are
 * matched on this form (the `users_email_lower_idx` unique index enforces
 * it), so "Admin@X.io " and "admin@x.io" are the same account.
 */
export function normalizeEmail(value: string): string {
	return value.trim().toLowerCase();
}

/**
 * Email field that normalizes before validating (`normalizeEmail`), so
 * forms and server functions always see the canonical address.
 */
export function emailSchema(params?: Parameters<typeof z.email>[0]) {
	return z.string().transform(normalizeEmail).pipe(z.email(params));
}

/** True when `value`, once normalized, is a valid email address. */
export function isEmail(value: string): boolean {
	return z.email().safeParse(normalizeEmail(value)).success;
}
