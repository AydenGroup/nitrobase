import { type AuditActionId, auditActions } from "#/config/audit-actions.ts";
import type { AuditTargetType } from "#/config/audit-targets.ts";
import { db } from "#/db/index.ts";
import { auditEvents } from "#/db/schema/platform.ts";
import type { Actor } from "#/features/auth/access.ts";
import { redactAuditMeta } from "./audit-redact";
import { emitEvent } from "./events/bus";
import { currentRequestInfo, type RequestInfo } from "./request-info";

export interface AuditEvent {
	/** Who acted and in which team (preferred over userId/teamId). */
	actor?: Actor;
	/** Account events without an actor (sign-in, 2FA): the user concerned. */
	userId?: string | null;
	/** Team the action happened in; defaults to the actor's team. */
	teamId?: string | null;
	action: AuditActionId;
	targetType?: AuditTargetType;
	targetId?: string;
	/** Context only; redacted anyway, but never pass secrets. */
	meta?: Record<string, unknown>;
	/** Defaults to the current request's address and user agent. */
	request?: RequestInfo;
}

/**
 * Record a security-relevant action in `audit_events` (fire and forget: a
 * failed write is logged, never fails the action). Actions mapped to a
 * notification event in the registry also emit it. Actions taken with an
 * API token carry the token id in `meta`.
 */
export function audit(event: AuditEvent): void {
	const info = event.request ?? currentRequestInfo();
	const userId = event.userId ?? event.actor?.userId ?? null;
	const teamId =
		event.teamId !== undefined ? event.teamId : (event.actor?.teamId ?? null);
	// Key "via" (not "token…"): the redactor would hide a token-named key.
	const via =
		event.actor && event.actor.via !== "session"
			? {
					via: event.actor.tokenId
						? `api_token:${event.actor.tokenId}`
						: event.actor.via,
				}
			: {};
	const meta = redactAuditMeta(
		Object.keys(via).length ? { ...event.meta, ...via } : event.meta,
	);
	void db
		.insert(auditEvents)
		.values({
			userId,
			teamId,
			action: event.action,
			targetType: event.targetType ?? null,
			targetId: event.targetId ?? null,
			ip: info.ip,
			userAgent: info.userAgent,
			meta,
		})
		.catch((error) => {
			console.error("[audit] write failed", event.action, error);
		});
	const notify = (auditActions[event.action] as { event?: string }).event;
	if (notify && (userId || teamId)) {
		emitEvent({
			id: notify,
			teamId,
			userId,
			subject: `${event.action}:${event.targetId ?? ""}`,
			params: {
				action: event.action,
				ip: info.ip ?? "?",
			},
		});
	}
}
