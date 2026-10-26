import { z } from "zod";

export const AuditListSchema = z.object({
	/** Team activity, or the caller's own account events. */
	scope: z.enum(["team", "account"]).default("team"),
	action: z
		.string()
		.regex(/^[a-z0-9_.]+$/)
		.optional(),
	category: z
		.string()
		.regex(/^[a-z]+$/)
		.optional(),
	/** Free text over action, target and metadata. */
	q: z.string().trim().max(200).optional(),
	from: z.iso.datetime().optional(),
	to: z.iso.datetime().optional(),
	/** Rows older than this id (keyset pagination). */
	before: z.number().int().positive().optional(),
});
export type AuditListInput = z.infer<typeof AuditListSchema>;

export interface AuditEventDTO {
	id: number;
	userId: string | null;
	userEmail: string | null;
	action: string;
	targetType: string | null;
	targetId: string | null;
	/** Name of the target when it still exists in the team (app, server…). */
	targetName: string | null;
	ip: string | null;
	userAgent: string | null;
	/** Redacted metadata as JSON text. */
	meta: string | null;
	at: Date;
}

export interface AuditPage {
	rows: AuditEventDTO[];
	/** Pass as `before` for the next page; null on the last page. */
	nextBefore: number | null;
}
