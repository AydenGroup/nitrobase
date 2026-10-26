import { useLingui } from "@lingui/react";
import {
	ActionIcon,
	Anchor,
	Badge,
	Card,
	Group,
	Menu,
	Progress,
	SimpleGrid,
	Stack,
	Text,
	ThemeIcon,
} from "@mantine/core";
import {
	AppWindow,
	Cloud,
	Container,
	Database,
	EllipsisVertical,
	Monitor,
	Pencil,
	Server,
	Trash2,
} from "lucide-react";
import { liveServerStatus } from "#/components/monitoring/ServerLiveStatus";
import { StatusBadge } from "#/components/ui/StatusBadge";
import { serverStatusMeta } from "#/config/status.ts";
import type {
	ServerDTO,
	ServerSummaries,
	ServerSummary,
} from "#/features/servers/schema.ts";
import { LocalizedLink } from "#/libs/i18n.ts";
import { formatPercentPoints } from "#/libs/intl.ts";
import { toneColors } from "#/theme/tokens.ts";

/** One usage bar (CPU, RAM, disk); warns at the alert threshold. */
const UsageMeter: React.FC<{
	label: string;
	percent: number | null | undefined;
	threshold?: number;
}> = ({ label, percent, threshold }) => {
	const { i18n } = useLingui();
	const warn = threshold !== undefined && (percent ?? 0) >= threshold;
	return (
		<Stack gap={4}>
			<Group justify="space-between" gap={4} wrap="nowrap">
				<Text size="xs" c="dimmed">
					{label}
				</Text>
				<Text
					size="xs"
					fw={500}
					c={warn ? `${toneColors.danger}.6` : undefined}
					style={{ fontVariantNumeric: "tabular-nums" }}
				>
					{formatPercentPoints(i18n.locale, percent)}
				</Text>
			</Group>
			<Progress
				value={percent ?? 0}
				size={5}
				radius="xl"
				color={warn ? toneColors.danger : toneColors.progress}
				aria-hidden
			/>
		</Stack>
	);
};

/** "icon value" fact in the card footer. */
const Fact: React.FC<{ icon: typeof Server; children: React.ReactNode }> = ({
	icon: Icon,
	children,
}) => (
	<Group gap={4} wrap="nowrap">
		<Icon size={13} aria-hidden style={{ flexShrink: 0 }} />
		<Text size="xs" c="dimmed" truncate>
			{children}
		</Text>
	</Group>
);

/**
 * Server list card: status, address, live CPU/RAM/disk (or the next step
 * while not ready) and a footer of facts. The name is a stretched link, so
 * the whole card opens the server; the action menu sits above it.
 */
export const ServerCard: React.FC<{
	server: ServerDTO;
	summary?: ServerSummary;
	thresholds?: ServerSummaries["thresholds"];
	unreachable: Set<string>;
	manage: boolean;
	deleting: boolean;
	onEdit: () => void;
	onDelete: () => void;
}> = ({
	server,
	summary,
	thresholds,
	unreachable,
	manage,
	deleting,
	onEdit,
	onDelete,
}) => {
	const { i18n } = useLingui();
	const status = liveServerStatus(server, unreachable);
	const meta = serverStatusMeta({ status, isDefault: server.isDefault });
	const health = summary?.health;
	const showUsage = status === "ready" && !!health?.ts;

	return (
		<Card p={0} className="link-card">
			<Stack gap="md" p="md" style={{ flex: 1 }}>
				<Group justify="space-between" align="flex-start" wrap="nowrap">
					<Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
						<ThemeIcon
							variant="light"
							color={toneColors[meta.tone]}
							size="lg"
							radius="md"
						>
							{server.isDefault ? <Monitor size={18} /> : <Server size={18} />}
						</ThemeIcon>
						<Stack gap={0} style={{ minWidth: 0 }}>
							<Group gap={6} wrap="nowrap">
								<Anchor
									component={LocalizedLink}
									to={`/servers/${server.id}`}
									className="link-card-link"
									fw={600}
									c="inherit"
									underline="never"
									truncate
								>
									{server.name}
								</Anchor>
								{server.isDefault && (
									<Badge color="violet" variant="light" size="xs">
										{i18n._("Default")}
									</Badge>
								)}
							</Group>
							<Text size="xs" c="dimmed" ff="monospace" truncate>
								{server.isDefault
									? i18n._("Local host")
									: `${server.username}@${server.host}:${server.port}`}
							</Text>
						</Stack>
					</Group>
					<Group gap={4} wrap="nowrap" className="link-card-actions">
						<StatusBadge meta={meta} />
						{manage && (
							<Menu position="bottom-end" withinPortal>
								<Menu.Target>
									<ActionIcon
										variant="subtle"
										color="gray"
										loading={deleting}
										aria-label={i18n._("Actions for {name}", {
											name: server.name,
										})}
									>
										<EllipsisVertical size={16} />
									</ActionIcon>
								</Menu.Target>
								<Menu.Dropdown>
									<Menu.Item
										leftSection={<Pencil size={14} />}
										onClick={onEdit}
									>
										{i18n._("Edit")}
									</Menu.Item>
									{!server.isDefault && (
										<Menu.Item
											color="red"
											leftSection={<Trash2 size={14} />}
											onClick={onDelete}
										>
											{i18n._("Delete")}
										</Menu.Item>
									)}
								</Menu.Dropdown>
							</Menu>
						)}
					</Group>
				</Group>

				{showUsage ? (
					<SimpleGrid cols={3} spacing="md">
						<UsageMeter label={i18n._("CPU")} percent={health?.cpuPercent} />
						<UsageMeter
							label={i18n._("RAM")}
							percent={health?.memPercent}
							threshold={thresholds?.memoryPercent}
						/>
						<UsageMeter
							label={i18n._("Disk")}
							percent={health?.disk?.percent}
							threshold={thresholds?.diskPercent}
						/>
					</SimpleGrid>
				) : (
					<Text size="xs" c="dimmed" lineClamp={2}>
						{i18n._(meta.hint)}
					</Text>
				)}
			</Stack>

			<Group
				gap="md"
				px="md"
				py="xs"
				wrap="wrap"
				style={{ borderTop: "1px solid var(--mantine-color-default-border)" }}
			>
				<Fact icon={AppWindow}>
					{i18n._("{count, plural, one {# app} other {# apps}}", {
						count: summary?.appCount ?? 0,
					})}
				</Fact>
				{(summary?.databaseCount ?? 0) > 0 && (
					<Fact icon={Database}>
						{i18n._("{count, plural, one {# database} other {# databases}}", {
							count: summary?.databaseCount ?? 0,
						})}
					</Fact>
				)}
				{server.dockerVersion && (
					<Fact icon={Container}>
						{i18n._("Docker {version}", { version: server.dockerVersion })}
					</Fact>
				)}
				{server.os && <Fact icon={Monitor}>{server.os}</Fact>}
				{server.tunnelEnabled && (
					<Fact icon={Cloud}>{i18n._("Cloudflare Tunnel")}</Fact>
				)}
			</Group>
		</Card>
	);
};
