import type { I18n } from "@lingui/core";
import { useLingui } from "@lingui/react";
import {
	Alert,
	Button,
	Checkbox,
	Group,
	List,
	Loader,
	Stack,
	Text,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Check, ShieldAlert } from "lucide-react";
import { useState } from "react";
import { bootstrapChanges } from "#/config/bootstrap-changes.ts";
import { APP_NAME } from "#/config/shared.ts";
import { previewBootstrapFn } from "#/features/servers/servers.functions.ts";
import { errorText } from "#/libs/coded.ts";
import { formatList } from "#/libs/intl.ts";

/**
 * Confirmation before a bootstrap: probes the server and lists what will
 * change (registry `#/config/bootstrap-changes.ts`). A server managed by
 * another Nitrobase instance is refused unless an instance admin ticks the
 * (audited) take-over option.
 */
const BootstrapConfirm: React.FC<{
	serverId: string;
	onCancel: () => void;
	onConfirm: (options: { takeover: boolean }) => void;
}> = ({ serverId, onCancel, onConfirm }) => {
	const { i18n } = useLingui();
	const [takeover, setTakeover] = useState(false);
	const preview = useQuery({
		queryKey: ["servers", serverId, "bootstrap-preview"],
		queryFn: () => previewBootstrapFn({ data: serverId }),
		staleTime: 0,
		gcTime: 0,
	});

	if (preview.isPending) {
		return (
			<Group gap="xs" py="md">
				<Loader size="sm" />
				<Text size="sm">{i18n._("Checking the server…")}</Text>
			</Group>
		);
	}
	const data = preview.data;
	if (!data) {
		return (
			<Stack>
				<Text size="sm" c="red">
					{preview.error?.message ?? i18n._("Could not check the server.")}
				</Text>
				<Group justify="flex-end">
					<Button variant="default" onClick={onCancel}>
						{i18n._("Cancel")}
					</Button>
				</Group>
			</Stack>
		);
	}
	const foreign = data.foreignOwner;
	const blocked = !!foreign && !(data.canTakeOver && takeover);
	const changes = bootstrapChanges.filter((change) => change.applies(data));

	return (
		<Stack gap="sm">
			{data.error && (
				<Alert color="yellow" icon={<AlertTriangle size={16} />}>
					{i18n._(
						"Could not reach the server to check it ({error}). This is what bootstrap would do:",
						{ error: errorText(i18n, data.error) },
					)}
				</Alert>
			)}
			{foreign && (
				<Alert
					color="red"
					icon={<ShieldAlert size={16} />}
					title={i18n._("Managed by another {appName} instance", {
						appName: APP_NAME,
					})}
				>
					<Stack gap="xs">
						<Text size="sm">
							{i18n._(
								"This server's Traefik and {appName} folders belong to instance {owner}. Bootstrapping here takes them over: that panel's routes and apps may stop working.",
								{ appName: APP_NAME, owner: foreign },
							)}
						</Text>
						{data.canTakeOver ? (
							<Checkbox
								checked={takeover}
								onChange={(event) => setTakeover(event.currentTarget.checked)}
								label={i18n._(
									"Take over this server (recorded in the audit log)",
								)}
							/>
						) : (
							<Text size="sm" fw={500}>
								{i18n._("Only an instance administrator can take it over.")}
							</Text>
						)}
					</Stack>
				</Alert>
			)}
			{data.unclaimedTraefik && (
				<Alert color="yellow" icon={<AlertTriangle size={16} />}>
					{i18n._(
						"{container} already runs here without an owner mark, and this panel has no apps on this server. If another {appName} panel manages this server, do not bootstrap it from here.",
						{ appName: APP_NAME, container: data.traefikContainer },
					)}
				</Alert>
			)}
			<Text size="sm">{i18n._("Bootstrap will:")}</Text>
			<List spacing={6} size="sm" center={false}>
				{changes.map((change) => (
					<List.Item
						key={change.id}
						icon={
							change.important ? (
								<AlertTriangle
									size={14}
									color="var(--mantine-color-orange-5)"
								/>
							) : (
								<Check size={14} />
							)
						}
					>
						<Text size="sm" fw={change.important ? 500 : undefined}>
							{i18n._({ ...change.label, values: change.values?.(data) })}
						</Text>
					</List.Item>
				))}
			</List>
			{data.portsBusy.length > 0 && (
				<Alert color="yellow" icon={<AlertTriangle size={16} />}>
					{i18n._(
						"Port(s) {ports} are already in use by another program: bootstrap stops before changing anything until they are free.",
						{
							ports: formatList(
								i18n.locale,
								data.portsBusy.map(String),
								"unit",
							),
						},
					)}
				</Alert>
			)}
			<Text size="xs" c="dimmed">
				{i18n._(
					"Existing containers keep running. Bootstrap is safe to run again.",
				)}
			</Text>
			<Group justify="flex-end">
				<Button variant="default" onClick={onCancel}>
					{i18n._("Cancel")}
				</Button>
				<Button
					color={foreign ? "red" : undefined}
					disabled={blocked}
					onClick={() => onConfirm({ takeover: !!foreign && takeover })}
				>
					{foreign ? i18n._("Take over and bootstrap") : i18n._("Bootstrap")}
				</Button>
			</Group>
		</Stack>
	);
};

/** Open the confirmation as a Mantine modal. */
export function openBootstrapConfirm(
	i18n: I18n,
	server: { id: string; name: string },
	onConfirm: (options: { takeover: boolean }) => void,
): void {
	const id = `bootstrap-${server.id}`;
	modals.open({
		modalId: id,
		title: i18n._("Bootstrap {name}", { name: server.name }),
		centered: true,
		size: "lg",
		children: (
			<BootstrapConfirm
				serverId={server.id}
				onCancel={() => modals.close(id)}
				onConfirm={(options) => {
					modals.close(id);
					onConfirm(options);
				}}
			/>
		),
	});
}
