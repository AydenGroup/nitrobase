import { createMiddleware } from "@tanstack/react-start";
import type { Permission } from "#/config/permissions.ts";
import { resolveSessionActor } from "#/features/teams/membership.server.ts";
import { AppError } from "#/utils/error.ts";
import { assertCanAccess } from "./access";
import { authMiddleware } from "./authMiddleware";

/**
 * Signed-in user + their active team: `context.actor` carries the team and
 * the role's permissions. Throws TEAM_NONE for an account without a team.
 */
const teamMiddleware = createMiddleware()
	.middleware([authMiddleware])
	.server(async ({ context, next }) => {
		const actor = await resolveSessionActor(context.user);
		if (!actor) throw new AppError("TEAM_NONE");
		return next({ context: { actor } });
	});

/**
 * The gate of every team-scoped server function: the caller's role in the
 * active team must grant `permission` (#/config/permissions.ts). Resource
 * lookups then check the resource's team with `assertCanAccess`.
 * `authz-coverage.test.ts` fails when a server function has no gate.
 */
export function requirePermission(permission: Permission) {
	return createMiddleware()
		.middleware([teamMiddleware])
		.server(async ({ context, next }) => {
			assertCanAccess(context.actor, permission);
			// Remember the gate: row checks that remap permissions (database
			// rows) re-check it against the resource.
			return next({
				context: { actor: { ...context.actor, gate: permission } },
			});
		});
}
