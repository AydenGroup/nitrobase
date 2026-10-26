import { useLingui } from "@lingui/react";
import { Stack } from "@mantine/core";
import { createFileRoute } from "@tanstack/react-router";
import { ApiTokensCard } from "#/components/teams/ApiTokens";
import { PageHeader } from "#/components/ui/PageHeader";
import { apiTokensQueryOptions } from "#/features/tokens/tokens.query.ts";

export const Route = createFileRoute("/{-$locale}/_authed/settings/tokens/")({
	loader: async ({ context }) => {
		await context.queryClient.ensureQueryData(apiTokensQueryOptions);
		return { crumb: context.i18n._("API tokens") };
	},
	component: TokensPage,
});

function TokensPage() {
	const { i18n } = useLingui();
	return (
		<Stack gap="lg">
			<PageHeader
				title={i18n._("API tokens")}
				description={i18n._("Automate deploys and backups from CI or scripts.")}
			/>
			<ApiTokensCard />
		</Stack>
	);
}
