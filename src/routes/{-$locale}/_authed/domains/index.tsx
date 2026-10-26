import { useLingui } from "@lingui/react";
import {
	Anchor,
	Badge,
	Button,
	Group,
	type MantineColor,
	Stack,
	Text,
	ThemeIcon,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Globe } from "lucide-react";
import { DataTable } from "#/components/ui/DataTable";
import { EmptyState } from "#/components/ui/EmptyState";
import { PageHeader } from "#/components/ui/PageHeader";
import { SectionCard } from "#/components/ui/SectionCard";
import { StatusBadge } from "#/components/ui/StatusBadge";
import { storedCheckText } from "#/config/check-details.ts";
import { domainCheckLabel } from "#/config/domain-checks.ts";
import { domainCheckStatuses } from "#/config/status.ts";
import { allDomainsQueryOptions } from "#/features/apps/apps.query.ts";
import { LocalizedLink } from "#/libs/i18n.ts";

export const Route = createFileRoute("/{-$locale}/_authed/domains/")({
	loader: async ({ context }) => {
		await context.queryClient.query(allDomainsQueryOptions).catch(() => null);
		return { crumb: context.i18n._("Domains") };
	},
	component: Domains,
});

function Domains() {
	const { i18n } = useLingui();
	const { data: domains = [], isLoading } = useQuery(allDomainsQueryOptions);
	return (
		<Stack gap="lg">
			<PageHeader
				title={i18n._("Domains")}
				description={i18n._(
					"All hostnames routed to your apps. Manage them from each app's Domains tab.",
				)}
			/>
			<SectionCard flush>
				<DataTable
					rows={domains}
					loading={isLoading}
					getRowKey={(domain) => domain.id}
					defaultSort={{ key: "host", direction: "asc" }}
					empty={
						<EmptyState
							compact
							icon={Globe}
							title={i18n._("No domains yet")}
							description={i18n._(
								"Domains appear here when you deploy an app.",
							)}
						>
							<Button
								component={LocalizedLink}
								to="/apps"
								size="xs"
								variant="light"
							>
								{i18n._("Go to apps")}
							</Button>
						</EmptyState>
					}
					columns={[
						{
							key: "host",
							header: i18n._("Host"),
							sortValue: (domain) => domain.host,
							render: (domain) => {
								const checkStatuses = Object.values(domain.checks).map(
									(c) => c.status,
								);
								const color: MantineColor = checkStatuses.includes("error")
									? "red"
									: checkStatuses.includes("warning")
										? "yellow"
										: checkStatuses.length > 0 &&
												checkStatuses.every((s) => s === "ok")
											? "teal"
											: "blue";

								return (
									<Group
										gap="sm"
										wrap="nowrap"
										align="center"
										style={{ minWidth: 0, overflow: "hidden" }}
									>
										<ThemeIcon
											variant="light"
											color={color}
											size="md"
											radius="md"
											style={{ flexShrink: 0 }}
										>
											<Globe size={16} />
										</ThemeIcon>
										<Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
											<Anchor
												href={`${domain.https ? "https" : "http"}://${domain.host}`}
												target="_blank"
												rel="noreferrer"
												size="sm"
												fw={500}
												truncate
											>
												{domain.host}
											</Anchor>
											{domain.primary && (
												<Badge
													size="xs"
													variant="light"
													style={{ flexShrink: 0 }}
												>
													{i18n._("Primary")}
												</Badge>
											)}
										</Group>
									</Group>
								);
							},
						},
						{
							key: "app",
							header: i18n._("App"),
							sortValue: (domain) => domain.appName,
							render: (domain) => (
								<Anchor
									component={LocalizedLink}
									to={`/apps/${domain.appId}`}
									search={{ tab: "domains" }}
									size="sm"
								>
									{domain.appName}
								</Anchor>
							),
						},
						{
							key: "service",
							header: i18n._("Service"),
							hideOnMobile: true,
							render: (domain) => (
								<Text size="sm">
									{domain.service}:{domain.port}
								</Text>
							),
						},
						{
							key: "checks",
							header: i18n._("Checks"),
							render: (domain) =>
								Object.keys(domain.checks).length === 0 ? (
									<Text size="xs" c="dimmed">
										{i18n._("Not checked")}
									</Text>
								) : (
									<Group gap={4}>
										{Object.entries(domain.checks).map(([id, check]) => (
											<Group key={id} gap={4} wrap="nowrap">
												<Text size="xs" c="dimmed">
													{domainCheckLabel(i18n, id)}
												</Text>
												<StatusBadge
													meta={domainCheckStatuses[check.status]}
													title={storedCheckText(i18n, check)}
													size="xs"
												/>
											</Group>
										))}
									</Group>
								),
						},
					]}
				/>
			</SectionCard>
		</Stack>
	);
}
