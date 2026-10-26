import { and, eq, inArray } from "drizzle-orm";
import { db } from "#/db/index.ts";
import { alerts } from "#/db/schema/monitoring.ts";
import {
	type AlertPlan,
	type AlertRule,
	alertRules,
	type OpenAlertKey,
} from "#/server/services/monitoring/alert-rules.ts";
import {
	type AlertEvent,
	emitAlert,
} from "#/server/services/monitoring/events.ts";

export type OpenAlertRow = typeof alerts.$inferSelect;

export async function loadOpenAlerts(
	serverId: string,
): Promise<OpenAlertRow[]> {
	return db
		.select()
		.from(alerts)
		.where(and(eq(alerts.serverId, serverId), eq(alerts.status, "open")));
}

function toEvent(type: AlertEvent["type"], row: OpenAlertRow): AlertEvent {
	return {
		type,
		alert: {
			id: row.id,
			teamId: row.teamId,
			serverId: row.serverId,
			appId: row.appId,
			rule: row.rule,
			subject: row.subject,
			severity: row.severity,
			value: row.value,
			threshold: row.threshold,
			openedAt: row.openedAt,
			resolvedAt: row.resolvedAt,
		},
	};
}

/**
 * Persist one tick's alert plan and emit opened/resolved events. Returns
 * the alerts open afterwards (the loop keeps them in memory).
 */
export async function applyAlertPlan(
	server: { id: string; teamId: string },
	open: OpenAlertRow[],
	plan: AlertPlan<OpenAlertRow & OpenAlertKey>,
	now: Date,
	rules: AlertRule[] = alertRules,
): Promise<OpenAlertRow[]> {
	const severity = new Map(rules.map((rule) => [rule.id, rule.severity]));
	const events: AlertEvent[] = [];
	let current = open;

	if (plan.resolve.length > 0) {
		const ids = plan.resolve.map((alert) => alert.id);
		const resolved = await db
			.update(alerts)
			.set({ status: "resolved", resolvedAt: now, lastSeenAt: now })
			.where(and(inArray(alerts.id, ids), eq(alerts.status, "open")))
			.returning();
		for (const row of resolved) events.push(toEvent("resolved", row));
		const gone = new Set(ids);
		current = current.filter((alert) => !gone.has(alert.id));
	}

	if (plan.seen.length > 0) {
		// Value changes are rare (rounded percent); one statement for the rest.
		const unchanged: string[] = [];
		for (const { alert, evaluation } of plan.seen) {
			const value = evaluation.value ?? null;
			if (value !== null && value !== alert.value) {
				await db
					.update(alerts)
					.set({ lastSeenAt: now, value })
					.where(eq(alerts.id, alert.id));
				alert.value = value;
			} else {
				unchanged.push(alert.id);
			}
			alert.lastSeenAt = now;
		}
		if (unchanged.length > 0) {
			await db
				.update(alerts)
				.set({ lastSeenAt: now })
				.where(inArray(alerts.id, unchanged));
		}
	}

	if (plan.open.length > 0) {
		const inserted = await db
			.insert(alerts)
			.values(
				plan.open.map((evaluation) => ({
					teamId: server.teamId,
					serverId: server.id,
					appId: evaluation.appId ?? null,
					rule: evaluation.rule,
					subject: evaluation.subject,
					severity: severity.get(evaluation.rule) ?? "warning",
					value: evaluation.value ?? null,
					threshold: evaluation.threshold ?? null,
					openedAt: now,
					lastSeenAt: now,
				})),
			)
			// Partial unique index: one open alert per (server, rule, subject).
			.onConflictDoNothing()
			.returning();
		for (const row of inserted) events.push(toEvent("opened", row));
		current = [...current, ...inserted];
	}

	for (const event of events) await emitAlert(event);
	return current;
}
