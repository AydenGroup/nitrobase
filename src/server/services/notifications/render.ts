import type { I18n, MessageDescriptor } from "@lingui/core";
import { auditActions } from "#/config/audit-actions.ts";
import { deliveryReasonLabels } from "#/config/git-delivery-reasons.ts";
import { type JobTitleSource, titleFor } from "#/config/job-titles.ts";
import { alertRuleMeta } from "#/config/metrics.ts";
import type { EventDefinition } from "#/config/notification-events.ts";
import { APP_NAME } from "#/config/shared.ts";
import { jobTypes, taskRunStatuses } from "#/config/status.ts";
import { formatCodedValue } from "#/libs/coded.ts";
import { EMPTY_VALUE } from "#/libs/intl.ts";
import type { PlatformEvent } from "#/server/services/events/bus.ts";
import type { NotificationMessage } from "./message";

/** Params holding registry ids, rendered as their translated label. */
const labelledParams: Record<string, Record<string, MessageDescriptor>> = {
	action: Object.fromEntries(
		Object.entries(auditActions).map(([id, meta]) => [id, meta.label]),
	),
	rule: Object.fromEntries(
		Object.entries(alertRuleMeta).map(([id, meta]) => [id, meta.label]),
	),
	job: jobTypes,
	status: Object.fromEntries(
		Object.entries(taskRunStatuses).map(([id, meta]) => [id, meta.label]),
	),
	reason: deliveryReasonLabels,
};

/**
 * One event param in the channel's language: registry ids become their
 * label (above), job titles and coded values (errors, sizes, lists) are
 * rendered like in the UI.
 */
function renderParam(
	i18n: I18n,
	key: string,
	value: PlatformEvent["params"][string],
): string {
	if (typeof value === "object" && value !== null && "$job" in value) {
		return titleFor(i18n, value.$job as JobTitleSource);
	}
	if (typeof value === "string") {
		const label = labelledParams[key]?.[value];
		if (label && Object.hasOwn(labelledParams[key], value)) {
			return i18n._(label);
		}
		return value;
	}
	return String(formatCodedValue(i18n, value));
}

export interface RenderContext {
	i18n: I18n;
	/** Owner email (`{user}`). */
	user: string;
	serverName: string | null;
	appName: string | null;
	/** APP_URL without trailing slash, or null. */
	baseUrl: string | null;
	labels: { server: string; app: string };
}

/** Panel page of the event: the app, else the server, else a section. */
export function linkFor(
	event: Pick<PlatformEvent, "serverId" | "appId">,
	definition: Pick<EventDefinition, "category">,
	baseUrl: string | null,
): string | null {
	if (!baseUrl) return null;
	if (event.appId) return `${baseUrl}/apps/${event.appId}`;
	if (event.serverId) return `${baseUrl}/servers/${event.serverId}`;
	if (definition.category === "security") return `${baseUrl}/settings/security`;
	if (definition.category === "backups") return `${baseUrl}/backups`;
	return baseUrl;
}

/** Render an event with its catalog templates. Pure given `ctx`. */
export function renderEvent(
	event: PlatformEvent,
	definition: EventDefinition,
	ctx: RenderContext,
): NotificationMessage {
	const params: Record<string, string> = {
		appName: APP_NAME,
		user: ctx.user,
		target: ctx.appName ?? ctx.serverName ?? APP_NAME,
		server: ctx.serverName ?? EMPTY_VALUE,
		subject: event.subject,
	};
	for (const [key, value] of Object.entries(event.params)) {
		params[key] = renderParam(ctx.i18n, key, value);
	}
	const fields = [
		...(ctx.serverName
			? [{ label: ctx.labels.server, value: ctx.serverName }]
			: []),
		...(ctx.appName ? [{ label: ctx.labels.app, value: ctx.appName }] : []),
	];
	return {
		eventId: event.id,
		severity: event.severity ?? definition.severity,
		title: ctx.i18n._({ ...definition.title, values: params }),
		body: ctx.i18n._({ ...definition.body, values: params }),
		url: linkFor(event, definition, ctx.baseUrl),
		at: event.at ?? new Date(),
		fields,
	};
}

/**
 * A test message for one catalog event ("Send test"): rendered with its own
 * templates, every placeholder filled with a sample marker, title prefixed.
 */
export function renderSampleEvent(
	definition: EventDefinition,
	ctx: RenderContext & {
		prefix: string;
		/** Sample value per placeholder (`default` for the others), translated. */
		samples: Record<string, string>;
	},
): NotificationMessage {
	const placeholders = new Set(
		[definition.title.id, definition.body.id, definition.label.id]
			.flatMap((text) => [...(text ?? "").matchAll(/\{(\w+)\}/g)])
			.map((match) => match[1]),
	);
	const params = Object.fromEntries(
		[...placeholders]
			// The brand is a real value, not a sample.
			.filter((name) => name !== "appName")
			.map((name) => [name, ctx.samples[name] ?? ctx.samples.default ?? name]),
	);
	const message = renderEvent(
		{
			id: definition.id,
			teamId: null,
			subject: "test",
			params: { ...params, ...(definition.labelValues ?? {}) },
		},
		definition,
		ctx,
	);
	return { ...message, title: `${ctx.prefix} ${message.title}` };
}
