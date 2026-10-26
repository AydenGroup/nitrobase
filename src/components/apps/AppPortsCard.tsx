import { useLingui } from "@lingui/react";
import {
	Alert,
	Badge,
	Button,
	Group,
	Modal,
	NumberInput,
	Stack,
	Switch,
	Text,
} from "@mantine/core";
import { useQueryClient } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import { useState } from "react";
import { SectionCard } from "#/components/ui/SectionCard";
import { useAppMutation } from "#/components/ui/useAppMutation";
import { APP_NAME } from "#/config/shared.ts";
import { setPublishedPortsFn } from "#/features/apps/apps.functions.ts";
import type { AppOverview, AppPortView } from "#/features/apps/schema.ts";
import { translateTemplateText } from "#/libs/i18n.ts";

/**
 * Opt-in host ports declared by the template (`[[ports]]`). Off by default;
 * enabling one shows an explicit exposure warning. Applied on redeploy.
 */
export const AppPortsCard: React.FC<{ overview: AppOverview }> = ({
	overview,
}) => {
	const { i18n } = useLingui();
	const queryClient = useQueryClient();
	const [enabling, setEnabling] = useState<AppPortView | null>(null);
	const [hostPort, setHostPort] = useState<number>(0);
	const [loopbackOnly, setLoopbackOnly] = useState(true);
	const loopbackIds = overview.ports
		.filter((port) => port.loopback)
		.map((port) => port.id);

	const save = useAppMutation({
		mutationFn: async (ports: Record<string, number | null>) =>
			await setPublishedPortsFn({
				data: {
					appId: overview.app.id,
					ports,
					loopback: enabling
						? loopbackOnly
							? [...loopbackIds, enabling.id]
							: loopbackIds.filter((id) => id !== enabling.id)
						: loopbackIds,
					acknowledged: true,
				},
			}),
		success: i18n._("Saved. Redeploy the app to apply it."),
		// Enabling happens in the modal: show refusals under its port field.
		field: (ports) =>
			Object.values(ports).some((port) => port !== null)
				? "hostPort"
				: undefined,
		onSuccess: () => {
			setEnabling(null);
			queryClient.invalidateQueries({ queryKey: ["apps", overview.app.id] });
		},
	});
	const rangeError =
		hostPort < 1024 || hostPort > 65535
			? i18n._("Use a port between 1024 and 65535")
			: undefined;

	if (overview.ports.length === 0) return null;

	return (
		<SectionCard
			title={i18n._("Published ports")}
			description={i18n._(
				"Expose a service port directly on the server, bypassing Traefik. Off by default.",
			)}
		>
			<Stack gap="sm">
				{overview.ports.map((port) => (
					<Group key={port.id} justify="space-between" wrap="nowrap">
						<Stack gap={0} style={{ minWidth: 0 }}>
							<Group gap="xs">
								<Text size="sm" fw={500}>
									{translateTemplateText(i18n, port.label)}
								</Text>
								{port.hostPort !== null &&
									(port.loopback ? (
										<Badge size="xs" color="blue" variant="light">
											{i18n._("127.0.0.1:{port} (SSH tunnel)", {
												port: port.hostPort,
											})}
										</Badge>
									) : (
										<Badge size="xs" color="orange" variant="light">
											{i18n._("Public on :{port}", { port: port.hostPort })}
										</Badge>
									))}
							</Group>
							<Text size="xs" c="dimmed">
								{port.service}:{port.port}
								{port.description
									? ` · ${translateTemplateText(i18n, port.description)}`
									: ""}
							</Text>
						</Stack>
						<Switch
							aria-label={translateTemplateText(i18n, port.label)}
							checked={port.hostPort !== null}
							disabled={save.isPending}
							onChange={(event) => {
								if (event.currentTarget.checked) {
									setHostPort(port.defaultHostPort ?? port.port);
									setLoopbackOnly(true);
									save.clearFieldError();
									setEnabling(port);
								} else {
									save.mutate({ [port.id]: null });
								}
							}}
						/>
					</Group>
				))}
			</Stack>
			<Modal
				opened={enabling !== null}
				onClose={() => setEnabling(null)}
				title={i18n._("Publish {label}", {
					label: translateTemplateText(i18n, enabling?.label) ?? "",
				})}
				centered
			>
				<Stack>
					<Switch
						label={i18n._("Only on 127.0.0.1 (reach it through an SSH tunnel)")}
						description={i18n._(
							"Recommended: nothing is exposed to the network. Connect with ssh -L {port}:127.0.0.1:{port} to the server.",
							{ port: hostPort },
						)}
						checked={loopbackOnly}
						onChange={(event) => setLoopbackOnly(event.currentTarget.checked)}
					/>
					{!loopbackOnly && (
						<Alert color="red" icon={<TriangleAlert size={18} />}>
							{i18n._(
								"The port is opened on every network interface of the server and is reachable from the internet. Docker-published ports bypass host firewalls such as ufw and firewalld, so block it at your provider's firewall if needed. Traefik, HTTPS and {appName} do not protect it: only the service's own authentication does.",
								{ appName: APP_NAME },
							)}
						</Alert>
					)}
					<NumberInput
						label={i18n._("Host port")}
						value={hostPort}
						onChange={(value) => {
							save.clearFieldError();
							setHostPort(typeof value === "number" ? value : 0);
						}}
						error={rangeError ?? save.fieldError("hostPort")}
						min={1}
						max={65535}
					/>
					<Group justify="flex-end">
						<Button variant="default" onClick={() => setEnabling(null)}>
							{i18n._("Cancel")}
						</Button>
						<Button
							color={loopbackOnly ? undefined : "red"}
							loading={save.isPending}
							disabled={!!rangeError}
							onClick={() =>
								enabling && save.mutate({ [enabling.id]: hostPort })
							}
						>
							{loopbackOnly
								? i18n._("Publish on 127.0.0.1")
								: i18n._("I understand, publish it")}
						</Button>
					</Group>
				</Stack>
			</Modal>
		</SectionCard>
	);
};
