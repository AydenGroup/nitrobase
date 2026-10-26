import { assertHostname } from "#/server/services/templates/naming.ts";

/** Normalize a user-entered domain (accepts pasted URLs). Throws if invalid. */
export function normalizeDomainInput(value: string): string {
	const trimmed = value.trim().toLowerCase();
	const withoutScheme = trimmed.replace(/^[a-z]+:\/\//, "");
	const host = withoutScheme.split(/[/?#:]/)[0].replace(/\.$/, "");
	return assertHostname(host);
}
