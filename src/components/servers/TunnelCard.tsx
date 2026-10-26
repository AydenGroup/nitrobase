import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import {
	Anchor,
	Badge,
	Button,
	Code,
	Group,
	Stack,
	Switch,
	Text,
} from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ActionLogDrawer } from "#/components/servers/ActionLogDrawer";
import { SecretInput } from "#/components/ui/SecretInput.tsx";
import { SectionCard } from "#/components/ui/SectionCard";
import { useAppMutation } from "#/components/ui/useAppMutation";
import { DOCS_LINKS } from "#/config/docs-links.ts";
import { POLL_MS } from "#/config/polling.ts";
import type { ServerDTO, TunnelState } from "#/features/servers/schema.ts";
import {
	getTunnelStatusFn,
	updateServerTunnelFn,
} from "#/features/servers/servers.functions.ts";

const stateLabels = {
	connected: msg({ id: "Connected" }),
	connecting: msg({ id: "Connecting" }),
	failing: msg({ id: "Failing" }),
	stopped: msg({ id: "Not running" }),
	not_configured: msg({ id: "Not configured" }),
} satisfies Record<TunnelState, MessageDescriptor>;

const stateColors: Record<TunnelState, string> = {
	connected: "green",
	connecting: "yellow",
	failing: "red",
	stopped: "gray",
	not_configured: "gray",
};

/**
 * Server Settings → Cloudflare Tunnel: connector token (stored encrypted,
 * never shown again), on/off, tunnel-only mode, live connector state.
 */
export const TunnelCard: React.FC<{ server: ServerDTO; busy: boolean }> = ({
	server,
	busy,
}) => {
	const { i18n } = useLingui();
	const queryClient = useQueryClient();
	const [token, setToken] = useState("");
	const [enabled, setEnabled] = useState(server.tunnelEnabled);
	const [tunnelOnly, setTunnelOnly] = useState(server.tunnelOnly);
	const [job, setJob] = useState<string | null>(null);
	const status = useQuery({
		queryKey: ["servers", server.id, "tunnel"],
		queryFn: () => getTunnelStatusFn({ data: server.id }),
		enabled: server.status === "ready",
		refetchInterval: POLL_MS.background,
	});
	const save = useAppMutation({
		mutationFn: () =>
			updateServerTunnelFn({
				data: {
					serverId: server.id,
					token: token || undefined,
					enabled,
					tunnelOnly: enabled && tunnelOnly,
				},
			}),
		field: "tunnel",
		success: ({ deploymentId }) =>
			deploymentId ? null : i18n._("Saved. Bootstrap the server to apply it."),
		onSuccess: ({ deploymentId }) => {
			setToken("");
			setJob(deploymentId);
			if (!deploymentId) {
				void queryClient.invalidateQueries({ queryKey: ["servers"] });
			}
		},
	});
	const state: TunnelState = server.tunnelEnabled
		? (status.data?.state ?? "connecting")
		: "not_configured";

	return (
		<SectionCard
			title={i18n._("Cloudflare Tunnel")}
			description={i18n._(
				"Serve domains through a Cloudflare Tunnel instead of open ports. Create the tunnel in the Cloudflare dashboard (Zero Trust → Networks → Tunnels), copy its token here, and point each public hostname at the service shown below.",
			)}
			actions={
				<Badge color={stateColors[state]} variant="light">
					{i18n._(stateLabels[state])}
				</Badge>
			}
		>
			<Stack gap="sm">
				<SecretInput
					label={i18n._("Tunnel token")}
					placeholder={
						server.tunnelConfigured
							? i18n._("Stored (leave empty to keep it)")
							: "eyJhIjoi…"
					}
					value={token}
					onChange={(event) => {
						save.clearFieldError();
						setToken(event.currentTarget.value);
					}}
					error={save.fieldError()}
					autoComplete="off"
				/>
				<Switch
					label={i18n._("Run the tunnel connector on this server")}
					checked={enabled}
					onChange={(event) => setEnabled(event.currentTarget.checked)}
				/>
				<Switch
					label={i18n._("Tunnel only (ports 80 and 443 stay closed)")}
					description={i18n._(
						"Traefik publishes no ports and every domain of this server goes through the tunnel. Let's Encrypt is not used; Cloudflare serves the certificate.",
					)}
					disabled={!enabled}
					checked={enabled && tunnelOnly}
					onChange={(event) => setTunnelOnly(event.currentTarget.checked)}
				/>
				{status.data && status.data.restarts > 0 && (
					<Text size="xs" c="red">
						{i18n._(
							"The connector restarted {count, plural, one {# time} other {# times}}: the token is probably wrong or revoked.",
							{ count: status.data.restarts },
						)}
					</Text>
				)}
				<Text size="xs" c="dimmed">
					{i18n._("Hostname service in Cloudflare:")}{" "}
					<Code>{status.data?.service ?? "…"}</Code>{" "}
					<Anchor
						href={DOCS_LINKS.cloudflareTunnel}
						target="_blank"
						rel="noreferrer"
						size="xs"
					>
						{i18n._("Cloudflare guide")}
					</Anchor>
				</Text>
				<Group>
					<Button
						onClick={() => save.mutate()}
						loading={save.isPending}
						disabled={busy}
					>
						{i18n._("Save and apply")}
					</Button>
				</Group>
			</Stack>
			<ActionLogDrawer
				opened={job !== null}
				onClose={() => setJob(null)}
				serverName={server.name}
				title={i18n._("Cloudflare Tunnel")}
				deploymentId={job}
				onCompleted={() => {
					void queryClient.invalidateQueries({ queryKey: ["servers"] });
				}}
			/>
		</SectionCard>
	);
};
