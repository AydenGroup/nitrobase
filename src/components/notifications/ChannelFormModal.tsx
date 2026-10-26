import { useLingui } from "@lingui/react";
import {
	Button,
	Checkbox,
	Group,
	Modal,
	MultiSelect,
	ScrollArea,
	SegmentedControl,
	Select,
	Stack,
	Switch,
	Tabs,
	Text,
	TextInput,
} from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { notifications } from "#/components/ui/Notifications";
import {
	SchemaFormFields,
	useSchemaFormIssues,
} from "#/components/ui/SchemaFormFields";
import { useAppMutation } from "#/components/ui/useAppMutation";
import {
	channelDrivers,
	channelFields,
	describeDeliveryError,
	getChannelDriver,
} from "#/config/notification-channels.ts";
import {
	defaultSubscribedEvents,
	type EventCategory,
	type EventSeverity,
	eventCategories,
	notificationEvents,
	severityLabels,
	severityOrder,
} from "#/config/notification-events.ts";
import { appsQueryOptions } from "#/features/apps/apps.query.ts";
import {
	createChannelFn,
	testChannelFn,
	updateChannelFn,
} from "#/features/notifications/notifications.functions.ts";
import { channelsQueryOptions } from "#/features/notifications/notifications.query.ts";
import type {
	ChannelDTO,
	ChannelSubscription,
} from "#/features/notifications/schema.ts";
import { serversQueryOptions } from "#/features/servers/servers.query.ts";
import { useEventLabel } from "./useEventLabel";

/** Event checkboxes grouped by category, with a minimum-severity shortcut. */
const SubscriptionEditor: React.FC<{
	value: ChannelSubscription;
	onChange: (next: ChannelSubscription) => void;
	/** Saved channel: each event gets a "Send test" button. */
	channelId?: string;
}> = ({ value, onChange, channelId }) => {
	const { i18n } = useLingui();
	const sendTest = useAppMutation({
		mutationFn: async (eventId: string) =>
			await testChannelFn({ data: { id: channelId ?? "", eventId } }),
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
		},
	});
	const eventLabel = useEventLabel();
	const servers = useQuery(serversQueryOptions);
	const apps = useQuery(appsQueryOptions);
	const selected = new Set(value.events);
	const toggle = (ids: string[], on: boolean) => {
		const next = new Set(selected);
		for (const id of ids) {
			if (on) next.add(id);
			else next.delete(id);
		}
		onChange({ ...value, events: [...next] });
	};
	const bySeverity = (min: EventSeverity) =>
		onChange({
			...value,
			events: notificationEvents
				.filter(
					(event) =>
						severityOrder.indexOf(event.severity) >= severityOrder.indexOf(min),
				)
				.map((event) => event.id),
		});
	return (
		<Stack gap="sm">
			<Group gap="xs" align="center">
				<Text size="sm">{i18n._("Select by severity:")}</Text>
				<SegmentedControl
					size="xs"
					value=""
					onChange={(next) => bySeverity(next as EventSeverity)}
					data={severityOrder.map((severity) => ({
						value: severity,
						label: `≥ ${i18n._(severityLabels[severity])}`,
					}))}
				/>
				<Button
					size="xs"
					variant="subtle"
					onClick={() =>
						onChange({ ...value, events: defaultSubscribedEvents() })
					}
				>
					{i18n._("Defaults")}
				</Button>
			</Group>
			<ScrollArea.Autosize mah={320} type="auto">
				<Stack gap="md">
					{(Object.keys(eventCategories) as EventCategory[]).map((category) => {
						const events = notificationEvents.filter(
							(event) => event.category === category,
						);
						const ids = events.map((event) => event.id);
						const count = ids.filter((id) => selected.has(id)).length;
						return (
							<Stack key={category} gap={4}>
								<Checkbox
									fw={600}
									label={i18n._(eventCategories[category])}
									checked={count === ids.length}
									indeterminate={count > 0 && count < ids.length}
									onChange={(event) => toggle(ids, event.currentTarget.checked)}
								/>
								{events.map((event) => (
									<Group
										key={event.id}
										ml="lg"
										justify="space-between"
										wrap="nowrap"
										gap="xs"
									>
										<Checkbox
											size="xs"
											label={
												event.critical
													? i18n._("{event} · {severity} · always sent", {
															event: eventLabel(event.id),
															severity: i18n._(severityLabels[event.severity]),
														})
													: i18n._("{event} · {severity}", {
															event: eventLabel(event.id),
															severity: i18n._(severityLabels[event.severity]),
														})
											}
											checked={selected.has(event.id)}
											onChange={(change) =>
												toggle([event.id], change.currentTarget.checked)
											}
										/>
										{channelId && (
											<Button
												size="compact-xs"
												variant="subtle"
												loading={
													sendTest.isPending && sendTest.variables === event.id
												}
												onClick={() => sendTest.mutate(event.id)}
											>
												{i18n._("Send test")}
											</Button>
										)}
									</Group>
								))}
							</Stack>
						);
					})}
				</Stack>
			</ScrollArea.Autosize>
			<MultiSelect
				label={i18n._("Only these servers")}
				description={i18n._(
					"Empty: all. Events that concern no server or app (sign-ins) always pass.",
				)}
				data={(servers.data ?? []).map((server) => ({
					value: server.id,
					label: server.name,
				}))}
				value={value.serverIds}
				onChange={(serverIds) => onChange({ ...value, serverIds })}
				clearable
				searchable
			/>
			<MultiSelect
				label={i18n._("Or these apps")}
				data={(apps.data ?? []).map((app) => ({
					value: app.id,
					label: `${app.name} (${app.folder})`,
				}))}
				value={value.appIds}
				onChange={(appIds) => onChange({ ...value, appIds })}
				clearable
				searchable
			/>
		</Stack>
	);
};

const emptySubscription = (): ChannelSubscription => ({
	events: defaultSubscribedEvents(),
	serverIds: [],
	appIds: [],
});

/** Add or edit a channel: settings (generated form) and events. */
export const ChannelFormModal: React.FC<{
	opened: boolean;
	onClose: () => void;
	channel?: ChannelDTO | null;
}> = ({ opened, onClose, channel }) => {
	const { i18n } = useLingui();
	const queryClient = useQueryClient();
	const [type, setType] = useState(channel?.type ?? "webhook");
	const [name, setName] = useState(channel?.name ?? "");
	const [enabled, setEnabled] = useState(channel?.enabled ?? true);
	const [config, setConfig] = useState<Record<string, unknown>>(
		channel?.config ?? {},
	);
	const [subscription, setSubscription] = useState<ChannelSubscription>(
		channel?.subscription ?? emptySubscription(),
	);
	// Checked here first so problems show under their field.
	const issues = useSchemaFormIssues();
	const clearIssues = issues.clear;
	useEffect(() => {
		if (!opened) return;
		setType(channel?.type ?? "webhook");
		setName(channel?.name ?? "");
		setEnabled(channel?.enabled ?? true);
		setConfig(channel?.config ?? {});
		setSubscription(channel?.subscription ?? emptySubscription());
		clearIssues();
	}, [opened, channel, clearIssues]);
	const driver = getChannelDriver(type);
	const submit = () => {
		if (issues.check(driver?.schema, config, !!channel)) save.mutate();
	};

	const save = useAppMutation({
		mutationFn: async () => {
			const data = { name, type, config, enabled, subscription };
			return channel
				? await updateChannelFn({ data: { id: channel.id, ...data } })
				: await createChannelFn({ data });
		},
		success: i18n._("Channel saved"),
		field: "config",
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: channelsQueryOptions.queryKey,
			});
			onClose();
		},
	});

	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={channel ? i18n._("Edit channel") : i18n._("Add channel")}
			size="lg"
			centered
		>
			<Tabs defaultValue="settings">
				<Tabs.List mb="md">
					<Tabs.Tab value="settings">{i18n._("Settings")}</Tabs.Tab>
					<Tabs.Tab value="events">
						{i18n._("Events ({count})", { count: subscription.events.length })}
					</Tabs.Tab>
				</Tabs.List>
				<Tabs.Panel value="settings">
					<Stack>
						<Select
							label={i18n._("Type")}
							data={channelDrivers.map((item) => ({
								value: item.type,
								label: i18n._(item.label),
							}))}
							value={type}
							onChange={(value) => {
								if (!value) return;
								setType(value);
								setConfig({});
							}}
							disabled={!!channel}
							allowDeselect={false}
							description={driver ? i18n._(driver.description) : undefined}
						/>
						<TextInput
							label={i18n._("Name")}
							value={name}
							onChange={(event) => setName(event.currentTarget.value)}
							required
						/>
						{driver && (
							<SchemaFormFields
								fields={channelFields(driver)}
								values={config}
								onChange={(field, value) => {
									save.clearFieldError();
									issues.clear(field);
									setConfig((prev) => ({ ...prev, [field]: value }));
								}}
								editing={!!channel}
								errors={issues.issues}
							/>
						)}
						<Switch
							label={i18n._("Enabled")}
							checked={enabled}
							onChange={(event) => setEnabled(event.currentTarget.checked)}
						/>
						<Text size="xs" c="dimmed">
							{i18n._(
								"Credentials are encrypted at rest and never shown again.",
							)}
						</Text>
					</Stack>
				</Tabs.Panel>
				<Tabs.Panel value="events">
					<SubscriptionEditor
						value={subscription}
						onChange={setSubscription}
						channelId={channel?.id}
					/>
				</Tabs.Panel>
			</Tabs>
			{save.fieldError() && (
				<Text size="sm" c="red" mt="sm">
					{save.fieldError()}
				</Text>
			)}
			<Group justify="flex-end" mt="md">
				<Button variant="default" onClick={onClose}>
					{i18n._("Cancel")}
				</Button>
				<Button
					loading={save.isPending}
					disabled={!name.trim()}
					onClick={submit}
				>
					{i18n._("Save")}
				</Button>
			</Group>
		</Modal>
	);
};
