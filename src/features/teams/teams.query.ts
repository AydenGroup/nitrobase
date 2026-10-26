import { queryOptions } from "@tanstack/react-query";
import { STALE_MS } from "#/config/polling.ts";
import {
	getTeamContextFn,
	listInvitesFn,
	listMembersFn,
} from "./teams.functions";

/** Active team, the user's teams and their permissions in it. */
export const teamContextQueryOptions = queryOptions({
	queryKey: ["team-context"],
	queryFn: async () => await getTeamContextFn(),
	staleTime: STALE_MS.long,
});

export const membersQueryOptions = queryOptions({
	queryKey: ["team", "members"],
	queryFn: async () => await listMembersFn(),
});

export const invitesQueryOptions = queryOptions({
	queryKey: ["team", "invites"],
	queryFn: async () => await listInvitesFn(),
});
