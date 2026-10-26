import {
	and,
	desc,
	eq,
	gte,
	ilike,
	inArray,
	isNull,
	lt,
	lte,
	or,
	type SQL,
	sql,
} from "drizzle-orm";
import { auditActions } from "#/config/audit-actions.ts";
import type { AuditTargetType } from "#/config/audit-targets.ts";
import { downloadName } from "#/config/identifiers.ts";
import { getConfig } from "#/config/server.ts";
import { db } from "#/db/index.ts";
import { apps } from "#/db/schema/apps.ts";
import { backupDestinations, backups } from "#/db/schema/backups.ts";
import { auditEvents, notificationChannels } from "#/db/schema/platform.ts";
import { servers } from "#/db/schema/server.ts";
import { sshKeys } from "#/db/schema/ssh-keys.ts";
import { apiTokens, teamMembers, teams } from "#/db/schema/teams.ts";
import { users } from "#/db/schema/user.ts";
import {
	type Actor,
	assertCanAccess,
	NIL_UUID,
} from "#/features/auth/access.ts";
import {
	type AuditEventDTO,
	type AuditListInput,
	AuditListSchema,
	type AuditPage,
} from "./schema";

/**
 * `team`: everything that happened in the active team (needs audit.view,
 * checked by the gate). `account`: the caller's own account events
 * (sign-ins, 2FA, sessions); instance admins also see anonymous ones
 * (sign-in attempts for unknown emails).
 */
function conditions(actor: Actor, input: AuditListInput): SQL[] {
	if (input.scope !== "account") assertCanAccess(actor, "audit.view");
	const where: SQL[] =
		input.scope === "account"
			? [
					and(
						isNull(auditEvents.teamId),
						actor.instanceAdmin
							? or(
									eq(auditEvents.userId, actor.userId ?? NIL_UUID),
									isNull(auditEvents.userId),
								)
							: eq(auditEvents.userId, actor.userId ?? NIL_UUID),
					) as SQL,
				]
			: [eq(auditEvents.teamId, actor.teamId)];
	if (input.action) where.push(eq(auditEvents.action, input.action));
	if (input.category) {
		const ids = Object.entries(auditActions)
			.filter(([, meta]) => meta.category === input.category)
			.map(([id]) => id);
		where.push(inArray(auditEvents.action, ids.length ? ids : ["-"]));
	}
	if (input.q) {
		const pattern = `%${input.q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
		where.push(
			or(
				ilike(auditEvents.action, pattern),
				ilike(auditEvents.targetId, pattern),
				ilike(auditEvents.ip, pattern),
				sql`${auditEvents.meta}::text ilike ${pattern}`,
			) as SQL,
		);
	}
	if (input.from) where.push(gte(auditEvents.at, new Date(input.from)));
	if (input.to) where.push(lte(auditEvents.at, new Date(input.to)));
	return where;
}

const columns = {
	id: auditEvents.id,
	userId: auditEvents.userId,
	userEmail: users.email,
	action: auditEvents.action,
	targetType: auditEvents.targetType,
	targetId: auditEvents.targetId,
	ip: auditEvents.ip,
	userAgent: auditEvents.userAgent,
	meta: auditEvents.meta,
	at: auditEvents.at,
};

type AuditRow = Omit<AuditEventDTO, "meta" | "targetName"> & {
	meta: Record<string, unknown> | null;
};

function toDTO(row: AuditRow, names: Map<string, string>): AuditEventDTO {
	return {
		...row,
		meta: row.meta ? JSON.stringify(row.meta) : null,
		targetName: row.targetId
			? (names.get(`${row.targetType}:${row.targetId}`) ?? null)
			: null,
	};
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Names of audit targets that still exist in the actor's team (app,
 * server, destination…), keyed `<type>:<id>`. Deleted ones keep their id.
 */
async function resolveTargetNames(
	actor: Actor,
	rows: AuditRow[],
): Promise<Map<string, string>> {
	const ids = (type: AuditTargetType) => [
		...new Set(
			rows
				.filter((row) => row.targetType === type && row.targetId)
				.map((row) => row.targetId as string)
				.filter((id) => UUID.test(id)),
		),
	];
	const names = new Map<string, string>();
	const add = (
		type: AuditTargetType,
		found: { id: string; name: string }[],
	) => {
		for (const item of found) names.set(`${type}:${item.id}`, item.name);
	};
	const byTeam = async (
		type: AuditTargetType,
		table:
			| typeof apps
			| typeof servers
			| typeof backupDestinations
			| typeof notificationChannels
			| typeof sshKeys
			| typeof apiTokens,
	) => {
		const list = ids(type);
		if (list.length === 0) return;
		add(
			type,
			await db
				.select({ id: table.id, name: table.name })
				.from(table)
				.where(and(inArray(table.id, list), eq(table.teamId, actor.teamId))),
		);
	};
	const backupIds = ids("backup");
	const userIds = ids("user");
	const teamIds = ids("team").filter((id) => id === actor.teamId);
	await Promise.all([
		byTeam("app", apps),
		byTeam("server", servers),
		byTeam("backup_destination", backupDestinations),
		byTeam("notification_channel", notificationChannels),
		byTeam("ssh_key", sshKeys),
		byTeam("api_token", apiTokens),
		backupIds.length
			? db
					.select({ id: backups.id, name: backups.appName })
					.from(backups)
					.where(
						and(
							inArray(backups.id, backupIds),
							eq(backups.teamId, actor.teamId),
						),
					)
					.then((found) =>
						add(
							"backup",
							found.flatMap((item) =>
								item.name ? [{ id: item.id, name: item.name }] : [],
							),
						),
					)
			: null,
		// Members of this team only (no lookup of other accounts).
		userIds.length
			? db
					.select({ id: users.id, name: users.email })
					.from(users)
					.innerJoin(teamMembers, eq(teamMembers.userId, users.id))
					.where(
						and(
							inArray(users.id, userIds),
							eq(teamMembers.teamId, actor.teamId),
						),
					)
					.then((found) => add("user", found))
			: null,
		teamIds.length
			? db
					.select({ id: teams.id, name: teams.name })
					.from(teams)
					.where(inArray(teams.id, teamIds))
					// A never-named team has no name to show (the id is shown).
					.then((found) =>
						add(
							"team",
							found.flatMap((item) =>
								item.name ? [{ id: item.id, name: item.name }] : [],
							),
						),
					)
			: null,
	]);
	return names;
}

export async function listAuditEvents(
	actor: Actor,
	input: AuditListInput,
): Promise<AuditPage> {
	const size = getConfig().AUDIT_PAGE_SIZE;
	const where = conditions(actor, input);
	if (input.before) where.push(lt(auditEvents.id, input.before));
	const rows = await db
		.select(columns)
		.from(auditEvents)
		.leftJoin(users, eq(users.id, auditEvents.userId))
		.where(and(...where))
		.orderBy(desc(auditEvents.id))
		.limit(size + 1);
	const page = rows.slice(0, size);
	const names = await resolveTargetNames(actor, page);
	return {
		rows: page.map((row) => toDTO(row, names)),
		nextBefore: rows.length > size ? rows[size - 1].id : null,
	};
}

/** All matching rows (capped) for the CSV export. */
async function exportAuditEvents(
	actor: Actor,
	input: AuditListInput,
): Promise<AuditEventDTO[]> {
	const rows = await db
		.select(columns)
		.from(auditEvents)
		.leftJoin(users, eq(users.id, auditEvents.userId))
		.where(and(...conditions(actor, input)))
		.orderBy(desc(auditEvents.id))
		.limit(getConfig().AUDIT_EXPORT_MAX_ROWS);
	const names = await resolveTargetNames(actor, rows);
	return rows.map((row) => toDTO(row, names));
}

/** RFC 4180 CSV; cells starting with = + - @ are prefixed (formula injection). */
function toCsv(rows: AuditEventDTO[]): string {
	const cell = (value: unknown) => {
		let text =
			value === null || value === undefined
				? ""
				: value instanceof Date
					? value.toISOString()
					: String(value);
		if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
		return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
	};
	const header = [
		"at",
		"user",
		"action",
		"target_type",
		"target_id",
		"target_name",
		"ip",
		"user_agent",
		"meta",
	];
	const lines = rows.map((row) =>
		[
			row.at,
			row.userEmail ?? row.userId,
			row.action,
			row.targetType,
			row.targetId,
			row.targetName,
			row.ip,
			row.userAgent,
			row.meta,
		]
			.map(cell)
			.join(","),
	);
	return `${[header.join(","), ...lines].join("\r\n")}\r\n`;
}

/** HTTP handler body of `/api/audit/export`: CSV with the page's filters. */
export async function auditExportResponse(
	actor: Actor,
	request: Request,
): Promise<Response> {
	const url = new URL(request.url);
	const parsed = AuditListSchema.safeParse(
		Object.fromEntries(url.searchParams),
	);
	if (!parsed.success) {
		return Response.json({ message: "Bad request" }, { status: 400 });
	}
	const rows = await exportAuditEvents(actor, parsed.data);
	const stamp = new Date().toISOString().slice(0, 10);
	return new Response(toCsv(rows), {
		headers: {
			"Content-Type": "text/csv; charset=utf-8",
			"Content-Disposition": `attachment; filename="${downloadName(`audit-${stamp}`)}.csv"`,
			"Cache-Control": "no-store",
		},
	});
}
