import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { appUpdatesQueryOptions } from "#/features/app-updates/app-updates.query.ts";
import type { AppUpdateView } from "#/features/app-updates/schema.ts";

/** Update state of the team's apps, by app id (badges, lists). */
export function useAppUpdates(): Map<string, AppUpdateView> {
	const { data } = useQuery(appUpdatesQueryOptions);
	return useMemo(
		() => new Map((data ?? []).map((view) => [view.appId, view])),
		[data],
	);
}
