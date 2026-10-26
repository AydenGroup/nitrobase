import { useQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import {
	databaseRowRequirements,
	type Permission,
} from "#/config/permissions.ts";
import { teamContextQueryOptions } from "#/features/teams/teams.query.ts";

/**
 * Role-aware UI: `can("app.deploy")` is true when the active team role
 * grants it. Only hides or disables controls; the server checks anyway.
 */
export function useCan(): (permission: Permission) => boolean {
	const { data } = useQuery(teamContextQueryOptions);
	return useCallback(
		(permission: Permission) => !!data?.permissions.includes(permission),
		[data],
	);
}

/**
 * `useCan` for an app page: on a database (an app row), app permissions
 * stand for the database ones (`databaseRowRequirements`), as on the server.
 */
export function useCanOnApp(
	isDatabase: boolean,
): (permission: Permission) => boolean {
	const can = useCan();
	return useCallback(
		(permission: Permission) =>
			isDatabase
				? databaseRowRequirements(permission).every(can)
				: can(permission),
		[can, isDatabase],
	);
}
