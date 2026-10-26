import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import {
	ActionIcon,
	Badge,
	Button,
	Group,
	Menu,
	Select,
	Stack,
	Text,
	Tooltip,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
	Bell,
	CheckCircle2,
	CircleX,
	MoreHorizontal,
	Plus,
	Send,
} from "lucide-react";
import { useState } from "react";
import { ChannelFormModal } from "#/components/notifications/ChannelFormModal";
import { useEventLabel } from "#/components/notifications/useEventLabel";
import { CopyField } from "#/components/ui/CopyField";
import { DataTable } from "#/components/ui/DataTable";
import { EmptyState } from "#/components/ui/EmptyState";
import { LocalDate } from "#/components/ui/LocalDate";
import { notifications } from "#/components/ui/Notifications";
import { PageHeader } from "#/components/ui/PageHeader";
import { SectionCard } from "#/components/ui/SectionCard";
import { StatusBadge } from "#/components/ui/StatusBadge";
import { useAppMutation } from "#/components/ui/useAppMutation";
import { WEBHOOK_HEADERS } from "#/config/identifiers.ts";
import {
	describeDeliveryError,
	getChannelDriver,
} from "#/config/notification-channels.ts";
import type { StatusMeta } from "#/config/status.ts";
import {
	deleteChannelFn,
	revealSigningSecretFn,
	testChannelFn,
} from "#/features/notifications/notifications.functions.ts";
import {
	channelsQueryOptions,
	deliveriesQueryOptions,
} from "#/features/notifications/notifications.query.ts";
import type {
	ChannelDTO,
	DeliveryDTO,
} from "#/features/notifications/schema.ts";

export const Route = createFileRoute(
	"/{-$locale}/_authed/settings/notifications/",
)({
	loader: async ({ context }) => {
		await context.queryClient.query(channelsQueryOptions).catch(() => null);
		return { crumb: context.i18n._("Notifications") };
	},
	component: Page,
});

const deliveryStatuses: Record<DeliveryDTO["status"], StatusMeta> = {
	pending: { label: msg({ id: "Sending" }), tone: "progress", busy: true },
	sent: { label: msg({ id: "Sent" }), tone: "success" },
	failed: { label: msg({ id: "Failed" }), tone: "danger" },
	suppressed: { label: msg({ id: "Suppressed" }), tone: "neutral" },
};

const suppressedReasons: Record<string, ReturnType<typeof msg>> = {
	duplicate: msg({ id: "Same event sent recently" }),
	rate_limited: msg({ id: "Channel rate limit reached" }),
};

function Page() {
	const { i18n } = useLingui();
	const queryClient = useQueryClient();
	const eventLabel = useEventLabel();
	const channels = useQuery(channelsQueryOptions);
	const [channelFilter, setChannelFilter] = useState<string | null>(null);
	const deliveries = useQuery(
		deliveriesQueryOptions(channelFilter ?? undefined),
	);
	const [editing, setEditing] = useState<ChannelDTO | null | undefined>(
		undefined,
	);
	const refresh = () =>
		queryClient.invalidateQueries({ queryKey: ["notifications"] });

	const test = useAppMutation({
		mutationFn: async (id: string) => await testChannelFn({ data: { id } }),
		success: (result) => (result.ok ? i18n._("Test message sent") : null),
		onSuccess: (result) => {
			if (!result.ok) {
				notifications.error({
					message: describeDeliveryError(
						i18n,
						`${result.kind}: ${result.error ?? ""}`,
					),
				});
			}
			return refresh();
		},
	});
	const remove = useAppMutation({
		mutationFn: async (id: string) => await deleteChannelFn({ data: { id } }),
		success: i18n._("Channel deleted"),
		onSuccess: refresh,
	});
	const reveal = useAppMutation({
		mutationFn: async (id: string) =>
			await revealSigningSecretFn({ data: { id } }),
		onSuccess: ({ secret }) =>
			modals.open({
				title: i18n._("Signing secret"),
				centered: true,
				size: "lg",
				children: (
					<Stack gap="xs">
						<Text size="sm">
							{i18n._(
								'Verify {signatureHeader} = sha256=HMAC-SHA256(secret, "<{timestampHeader}>.<raw body>") and reject old timestamps.',
								{
									signatureHeader: WEBHOOK_HEADERS.signature,
									timestampHeader: WEBHOOK_HEADERS.timestamp,
								},
							)}
						</Text>
						<CopyField value={secret} />
					</Stack>
				),
			}),
	});

	const lastTest = (row: ChannelDTO) => {
		if (!row.lastTest) return "—";
		return (
			<Group gap={4} wrap="nowrap">
				{row.lastTest.ok ? (
					<CheckCircle2 size={16} color="var(--mantine-color-green-6)" />
				) : (
					<CircleX size={16} color="var(--mantine-color-red-6)" />
				)}
				<Text
					size="xs"
					c={row.lastTest.ok ? "dimmed" : "red"}
					lineClamp={2}
					title={row.lastTest.error ?? undefined}
				>
					{row.lastTest.ok ? (
						<LocalDate value={row.lastTest.at} />
					) : (
						describeDeliveryError(i18n, row.lastTest.error)
					)}
				</Text>
			</Group>
		);
	};

	return (
		<Stack gap="lg">
			<PageHeader
				title={i18n._("Notifications")}
				description={i18n._(
					"Send job failures, monitoring alerts, certificate and security events to email, chat or your own webhook.",
				)}
				actions={
					<Button
						leftSection={<Plus size={16} />}
						onClick={() => setEditing(null)}
					>
						{i18n._("Add channel")}
					</Button>
				}
			/>
			<SectionCard title={i18n._("Channels")} flush>
				<DataTable
					rows={channels.data ?? []}
					loading={channels.isLoading}
					getRowKey={(row) => row.id}
					empty={
						<EmptyState
							compact
							icon={Bell}
							title={i18n._("No channels yet")}
							description={i18n._(
								"Add a channel to be told when something needs attention.",
							)}
							actionLabel={i18n._("Add channel")}
							action={() => setEditing(null)}
						/>
					}
					columns={[
						{
							key: "name",
							header: i18n._("Name"),
							render: (row) => (
								<Group gap="xs" wrap="nowrap">
									<Text size="sm" fw={500}>
										{row.name}
									</Text>
									{!row.enabled && (
										<Badge size="xs" color="gray" variant="light">
											{i18n._("Disabled")}
										</Badge>
									)}
								</Group>
							),
						},
						{
							key: "type",
							header: i18n._("Type"),
							render: (row) => {
								const driver = getChannelDriver(row.type);
								return driver ? i18n._(driver.label) : row.type;
							},
						},
						{
							key: "events",
							header: i18n._("Events"),
							render: (row) => row.subscription.events.length,
						},
						{
							key: "test",
							header: i18n._("Last test"),
							hideOnMobile: true,
							render: lastTest,
						},
						{
							key: "actions",
							header: "",
							align: "right",
							render: (row) => (
								<Group gap={4} justify="flex-end" wrap="nowrap">
									<Tooltip label={i18n._("Send a test message")}>
										<ActionIcon
											variant="subtle"
											aria-label={i18n._("Send a test message")}
											loading={test.isPending && test.variables === row.id}
											onClick={() => test.mutate(row.id)}
										>
											<Send size={16} />
										</ActionIcon>
									</Tooltip>
									<Menu position="bottom-end">
										<Menu.Target>
											<ActionIcon
												variant="subtle"
												aria-label={i18n._("More actions")}
											>
												<MoreHorizontal size={16} />
											</ActionIcon>
										</Menu.Target>
										<Menu.Dropdown>
											<Menu.Item onClick={() => setEditing(row)}>
												{i18n._("Edit")}
											</Menu.Item>
											{getChannelDriver(row.type)?.signsRequests && (
												<Menu.Item onClick={() => reveal.mutate(row.id)}>
													{i18n._("Show signing secret")}
												</Menu.Item>
											)}
											<Menu.Item
												color="red"
												onClick={() =>
													modals.openConfirmModal({
														title: i18n._("Delete channel"),
														centered: true,
														children: (
															<Text size="sm">
																{i18n._(
																	"{name} stops receiving notifications.",
																	{
																		name: row.name,
																	},
																)}
															</Text>
														),
														labels: {
															confirm: i18n._("Delete"),
															cancel: i18n._("Cancel"),
														},
														confirmProps: { color: "red" },
														onConfirm: () => remove.mutate(row.id),
													})
												}
											>
												{i18n._("Delete")}
											</Menu.Item>
										</Menu.Dropdown>
									</Menu>
								</Group>
							),
						},
					]}
				/>
			</SectionCard>
			<SectionCard
				title={i18n._("Delivery log")}
				actions={
					<Select
						size="xs"
						placeholder={i18n._("All channels")}
						data={(channels.data ?? []).map((row) => ({
							value: row.id,
							label: row.name,
						}))}
						value={channelFilter}
						onChange={setChannelFilter}
						clearable
						w={200}
					/>
				}
				flush
			>
				<DataTable
					rows={deliveries.data ?? []}
					loading={deliveries.isLoading}
					getRowKey={(row) => row.id}
					empty={
						<Text size="sm" c="dimmed" p="md">
							{i18n._("Nothing sent yet.")}
						</Text>
					}
					columns={[
						{
							key: "at",
							header: i18n._("Time"),
							render: (row) => (
								<LocalDate
									value={row.createdAt}
									options={{ dateStyle: "short", timeStyle: "medium" }}
								/>
							),
						},
						{
							key: "event",
							header: i18n._("Event"),
							render: (row) => (
								<Stack gap={0}>
									<Text size="sm">{row.title}</Text>
									<Text size="xs" c="dimmed">
										{eventLabel(row.eventId)} · {row.channelName}
									</Text>
								</Stack>
							),
						},
						{
							key: "status",
							header: i18n._("Status"),
							render: (row) => (
								<Stack gap={2}>
									<StatusBadge meta={deliveryStatuses[row.status]} />
									{row.status === "suppressed" && row.lastError && (
										<Text size="xs" c="dimmed">
											{suppressedReasons[row.lastError]
												? i18n._(suppressedReasons[row.lastError])
												: row.lastError}
										</Text>
									)}
									{row.status === "failed" && row.lastError && (
										<Text size="xs" c="red" lineClamp={2} title={row.lastError}>
											{describeDeliveryError(i18n, row.lastError)}
										</Text>
									)}
								</Stack>
							),
						},
						{
							key: "attempts",
							header: i18n._("Attempts"),
							align: "right",
							hideOnMobile: true,
							render: (row) => row.attempts,
						},
					]}
				/>
			</SectionCard>
			<ChannelFormModal
				opened={editing !== undefined}
				onClose={() => setEditing(undefined)}
				channel={editing}
			/>
		</Stack>
	);
}
