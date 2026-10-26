/**
 * Audit metadata must never hold secrets. Values under sensitive-looking
 * keys are replaced, long strings cut, deep or large structures trimmed.
 * Pure (tested).
 */
const SENSITIVE_KEY =
	/(pass(word|phrase)?|secret|webhook|token|private|credential|authoriz|cookie|signature|otp|totp|recovery|apikey|api_key|accesskey|access_key|session|^key$|_key$|[a-z]Key$|^value$|^values$|^env$|^config$)/i;
const MAX_STRING = 300;
const MAX_ITEMS = 50;
const MAX_DEPTH = 4;

export const REDACTED = "[redacted]";

function clean(value: unknown, depth: number): unknown {
	if (value === null || value === undefined) return value ?? null;
	if (typeof value === "string") {
		return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
	}
	if (typeof value === "number" || typeof value === "boolean") return value;
	if (value instanceof Date) return value.toISOString();
	if (depth >= MAX_DEPTH) return "[…]";
	if (Array.isArray(value)) {
		return value.slice(0, MAX_ITEMS).map((item) => clean(item, depth + 1));
	}
	if (typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value).slice(0, MAX_ITEMS)) {
			out[key] = SENSITIVE_KEY.test(key) ? REDACTED : clean(item, depth + 1);
		}
		return out;
	}
	return String(value);
}

export function redactAuditMeta(
	meta: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
	if (!meta) return null;
	return clean(meta, 0) as Record<string, unknown>;
}
