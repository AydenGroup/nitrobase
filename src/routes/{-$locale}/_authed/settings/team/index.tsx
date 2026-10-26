import { useLingui } from "@lingui/react";
import { Stack } from "@mantine/core";
import { createFileRoute } from "@tanstack/react-router";
import {
	DeleteTeamCard,
	InvitesCard,
	MembersCard,
	RolesCard,
	TeamOverviewCard,
} from "#/components/teams/TeamSettings";
import { useCan } from "#/components/teams/useCan";
import { PageHeader } from "#/components/ui/PageHeader";
import { membersQueryOptions } from "#/features/teams/teams.query.ts";

export const Route = createFileRoute("/{-$locale}/_authed/settings/team/")({
	loader: async ({ context }) => {
		await context.queryClient.ensureQueryData(membersQueryOptions);
		return { crumb: context.i18n._("Team") };
	},
	component: TeamPage,
});

function TeamPage() {
	const { i18n } = useLingui();
	const can = useCan();
	return (
		<Stack gap="lg">
			<PageHeader
				title={i18n._("Team")}
				description={i18n._("Members, roles and invites of the active team.")}
			/>
			<TeamOverviewCard />
			<MembersCard />
			{can("members.manage") && <InvitesCard />}
			<RolesCard />
			{can("team.manage") && <DeleteTeamCard />}
		</Stack>
	);
}
