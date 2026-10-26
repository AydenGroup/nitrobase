import { useLingui } from "@lingui/react";
import { Alert, Button, Code, Group, List, Stack, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { ActionLogDrawer } from "#/components/servers/ActionLogDrawer";
import { SettingField } from "#/components/settings/SettingField";
import { UpgradeCard } from "#/components/settings/UpgradeCard";
import { PageHeader } from "#/components/ui/PageHeader";
import { SectionCard } from "#/components/ui/SectionCard";
import { useAppMutation } from "#/components/ui/useAppMutation";
import { APP_NAME, EXAMPLES, LOCAL_SERVER } from "#/config/shared.ts";
import { applyPanelDomainFn } from "#/features/settings/settings.functions.ts";
import {
	panelEnvHintsQueryOptions,
	settingsQueryOptions,
} from "#/features/settings/settings.query.ts";
import { upgradeOverviewQueryOptions } from "#/features/upgrade/upgrade.query.ts";

export const Route = createFileRoute("/{-$locale}/_authed/settings/instance")({
	loader: async ({ context }) => {
		await context.queryClient.query(settingsQueryOptions);
		// prefetchQuery never throws: a failed release check renders its error.
		await context.queryClient.prefetchQuery(upgradeOverviewQueryOptions);
		return { crumb: context.i18n._("Instance") };
	},
	component: InstanceSettings,
});

function InstanceSettings() {
	const { i18n } = useLingui();
	const { data: settings = [] } = useQuery(settingsQueryOptions);
	const panelDomain = settings.find(
		(item) => item.key === "instance.panelDomain",
	)?.value;
	const env = useQuery(
		panelEnvHintsQueryOptions(panelDomain ?? EXAMPLES.panelHost),
	);
	const [job, setJob] = useState<string | null>(null);
	const apply = useAppMutation({
		mutationFn: async () => await applyPanelDomainFn(),
		onSuccess: ({ deploymentId }) => setJob(deploymentId),
	});

	return (
		<Stack gap="lg">
			<PageHeader
				title={i18n._("Instance")}
				description={i18n._("Settings for this {appName} installation", {
					appName: APP_NAME,
				})}
			/>
			<UpgradeCard />
			<SectionCard
				title={i18n._("Panel domain")}
				description={i18n._(
					"Route a domain to this panel through Traefik on the Localhost server, with a Let's Encrypt certificate.",
				)}
			>
				<Stack>
					<SettingField
						settingKey="instance.panelDomain"
						placeholder={EXAMPLES.panelHost}
					/>
					<Group>
						<Button
							variant="light"
							loading={apply.isPending}
							onClick={() => apply.mutate()}
						>
							{panelDomain ? i18n._("Apply route") : i18n._("Remove route")}
						</Button>
					</Group>
					<Alert color="gray" variant="light" title={i18n._("Why Localhost?")}>
						<Text size="sm">
							{i18n._(
								"Traefik reaches the panel container over a private Docker network, so the route can only live on the machine that runs {appName} (the Localhost server). Bootstrap Localhost first (it only adds Traefik there). If you would rather not, put your own reverse proxy with HTTPS in front of the panel.",
								{ appName: APP_NAME },
							)}
						</Text>
					</Alert>
					<Alert color="blue" title={i18n._("After the route works")}>
						<List size="sm" spacing={8}>
							<List.Item>
								<Code>{env.data?.appUrl}</Code>
								<Text size="sm">
									{i18n._("Marks session cookies as Secure.")}
								</Text>
							</List.Item>
							<List.Item>
								<Code>{env.data?.bind}</Code>
								<Text size="sm">
									{i18n._(
										"Makes the panel unreachable over plain HTTP; restart {appName} after setting it.",
										{ appName: APP_NAME },
									)}
								</Text>
							</List.Item>
							<List.Item>
								<Code>TRUST_PROXY=true</Code>
								<Text size="sm">
									{i18n._(
										"Only when the panel is reachable through Traefik alone: sign-in limits, the audit log and new-device alerts then see real client addresses instead of Traefik's.",
									)}
								</Text>
							</List.Item>
						</List>
					</Alert>
				</Stack>
			</SectionCard>
			<ActionLogDrawer
				opened={job !== null}
				onClose={() => setJob(null)}
				serverName={LOCAL_SERVER.name}
				title={i18n._("Panel domain")}
				deploymentId={job}
			/>
		</Stack>
	);
}
