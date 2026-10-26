import { useLingui } from "@lingui/react";
import { Stack } from "@mantine/core";
import { createFileRoute } from "@tanstack/react-router";
import { SettingField } from "#/components/settings/SettingField";
import { PageHeader } from "#/components/ui/PageHeader";
import { SectionCard } from "#/components/ui/SectionCard";
import { settingsQueryOptions } from "#/features/settings/settings.query.ts";

export const Route = createFileRoute("/{-$locale}/_authed/settings/github")({
	loader: async ({ context }) => {
		await context.queryClient.query(settingsQueryOptions);
		return { crumb: context.i18n._("GitHub token") };
	},
	component: GitHubSettings,
});

function GitHubSettings() {
	const { i18n } = useLingui();
	return (
		<Stack gap="lg">
			<PageHeader
				title={i18n._("GitHub token")}
				description={i18n._(
					"Template versions come from the GitHub API, which allows 60 requests per hour without a token and 5,000 with one.",
				)}
			/>
			<SectionCard>
				<SettingField settingKey="github.token" placeholder="github_pat_..." />
			</SectionCard>
		</Stack>
	);
}
