import {
	isPermission,
	type Permission,
	permissions,
	type RoleId,
	rolePermissions,
} from "#/config/permissions.ts";
import type { ErrorCode } from "#/libs/error-codes.ts";
import { AppError } from "#/utils/error.ts";

/**
 * Who is acting, in which team, with which permissions. Built once per
 * request (session or API token) or for background work (`systemActor`).
 */
export interface Actor {
	/** The member acting; null for team tokens and background jobs of a team. */
	userId: string | null;
	teamId: string;
	role: RoleId | null;
	permissions: ReadonlySet<Permission>;
	/** Instance administrator (instance-scoped permissions). */
	instanceAdmin: boolean;
	via: "session" | "token" | "system";
	sessionId?: string;
	tokenId?: string;
	/**
	 * The permission the request's gate checked (server function middleware,
	 * REST route). Resource checks that remap permissions (database rows,
	 * see `databaseRowPermission`) re-check it against the resource.
	 */
	gate?: Permission;
}

/** Permissions of a member: their role's, plus instance ones for admins. */
export function memberPermissions(
	role: RoleId,
	instanceAdmin: boolean,
): Set<Permission> {
	const granted = new Set<Permission>(rolePermissions(role));
	if (instanceAdmin) {
		for (const id of Object.keys(permissions)) {
			if (isPermission(id) && permissions[id].scope === "instance") {
				granted.add(id);
			}
		}
	}
	return granted;
}

/**
 * Actor for scheduled/background work of a team (backups, recovery,
 * pending routes): every team permission, attributed to `userId` when the
 * work was set up by a member.
 */
export function systemActor(
	teamId: string,
	userId: string | null = null,
	options: { instance?: boolean } = {},
): Actor {
	return {
		userId,
		teamId,
		role: null,
		permissions: options.instance
			? memberPermissions("owner", true)
			: new Set(rolePermissions("owner")),
		instanceAdmin: !!options.instance,
		via: "system",
	};
}

export function can(actor: Actor, permission: Permission): boolean {
	return actor.permissions.has(permission);
}

/**
 * The single access gate. Without a resource: the actor holds
 * `permission` in its team (else FORBIDDEN). With a resource: it must also
 * belong to the actor's team; a resource of another team (or a missing
 * one) is reported as `notFound`, never as forbidden, so ids of other
 * teams do not leak.
 */
export function assertCanAccess<T extends { teamId: string }>(
	actor: Actor,
	resource: T | null | undefined,
	permission: Permission,
	notFound: ErrorCode,
): T;
export function assertCanAccess(actor: Actor, permission: Permission): void;
export function assertCanAccess<T extends { teamId: string }>(
	actor: Actor,
	resourceOrPermission: T | null | undefined | Permission,
	permission?: Permission,
	notFound?: ErrorCode,
): T | undefined {
	if (typeof resourceOrPermission === "string") {
		if (!can(actor, resourceOrPermission)) {
			throw new AppError("FORBIDDEN", { permission: resourceOrPermission });
		}
		return undefined;
	}
	const resource = resourceOrPermission;
	if (!resource || resource.teamId !== actor.teamId) {
		throw new AppError((notFound ?? "NOT_FOUND") as "SERVER_NOT_FOUND");
	}
	if (permission && !can(actor, permission)) {
		throw new AppError("FORBIDDEN", { permission });
	}
	return resource;
}

/** Matches no row: stands in for "no member" in uuid comparisons. */
export const NIL_UUID = "00000000-0000-0000-0000-000000000000";
