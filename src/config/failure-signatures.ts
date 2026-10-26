import type { ErrorInfo } from "#/libs/coded.ts";
import { coded } from "#/utils/error.ts";

/**
 * Known failure signatures in a service's logs. While a deploy waits for
 * readiness, a crash-looping service's recent logs are matched against
 * these; a match becomes a coded hint in the job log and in the app's
 * error. A template may name the variable that works around a signature
 * (template.toml `[failure_hints.<id>] variable = "..."`).
 *
 * Adding a signature = an entry here (and its error codes); templates and
 * the deploy job need no change.
 */
export interface FailureSignature {
	/** Matched against the service's last log lines. */
	pattern: RegExp;
	/** The hint for a match (`variable`: the template's workaround, if any). */
	hint(input: {
		service: string;
		match: RegExpMatchArray;
		variable?: string;
	}): ErrorInfo;
}

/** Captured names are clipped: logs are not trusted for their length. */
const clip = (value: string | undefined) => (value ?? "").slice(0, 100);

const failureSignatures = {
	// Deno / Supabase edge-runtime resolving a `jsr:` import while the JSR
	// registry is unreachable or answers with a block page (HTTP 403).
	jsr_unreachable: {
		pattern: /JSR package manifest for '([^'\n]+)' failed to load/,
		hint: ({ service, match, variable }) =>
			variable
				? coded("SERVICE_JSR_UNREACHABLE_MIRROR", {
						service,
						package: clip(match[1]),
						variable,
					})
				: coded("SERVICE_JSR_UNREACHABLE", {
						service,
						package: clip(match[1]),
					}),
	},
} satisfies Record<string, FailureSignature>;

export type FailureSignatureId = keyof typeof failureSignatures;

export const FAILURE_SIGNATURE_IDS = Object.keys(failureSignatures) as [
	FailureSignatureId,
	...FailureSignatureId[],
];

/** First known signature in `logs` of `service`, as a coded hint. */
export function matchFailureSignature(
	logs: string,
	service: string,
	variables: Partial<Record<FailureSignatureId, { variable?: string }>> = {},
): ErrorInfo | null {
	for (const [id, signature] of Object.entries(failureSignatures) as [
		FailureSignatureId,
		FailureSignature,
	][]) {
		const match = logs.match(signature.pattern);
		if (match) {
			return signature.hint({
				service,
				match,
				variable: variables[id]?.variable,
			});
		}
	}
	return null;
}
