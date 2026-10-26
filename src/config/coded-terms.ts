import type { MessageDescriptor } from "@lingui/core";
import { sqlRiskLabels } from "#/config/sql-risks.ts";

/**
 * Registries of ids the server sends in coded params as `{ $terms }` (see
 * `#/libs/coded.ts`): each id renders as its label in the reader's
 * language, joined as a list. Adding a set = one entry here.
 */
export const codedTerms = {
	sql_risk: sqlRiskLabels,
} satisfies Record<string, Record<string, MessageDescriptor>>;

export type CodedTermSet = keyof typeof codedTerms;

/** The label of `id` in `set` (undefined: unknown set or id). */
export function codedTermLabel(
	set: string,
	id: string,
): MessageDescriptor | undefined {
	const terms = (
		codedTerms as Record<string, Record<string, MessageDescriptor>>
	)[set];
	return terms && Object.hasOwn(terms, id) ? terms[id] : undefined;
}
