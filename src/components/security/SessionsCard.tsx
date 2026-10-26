import { useLingui } from "@lingui/react";
import { Badge, Button, Group, Text } from "@mantine/core";
import { modals } from "@mantine/modals";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DataTable } from "#/components/ui/DataTable";
import { LocalDate } from "#/components/ui/LocalDate";
import { SectionCard } from "#/components/ui/SectionCard";
import { useAppMutation } from "#/components/ui/useAppMutation";
import {
	revokeOtherSessionsFn,
	revokeSessionFn,
} from "#/features/auth/security.functions.ts";
import { sessionsQueryOptions } from "#/features/auth/security.query.ts";

/** Browser + OS from a user agent, for humans (best effort). */
function describeUserAgent(ua: string | null): string {
	if (!ua) return "—";
	const browser =
		ua
			.match(/(Edg|OPR|Firefox|Chrome|Safari)\/[\d.]+/)?.[1]
			?.replace("Edg", "Edge")
			.replace("OPR", "Opera") ?? ua.split(" ")[0];
	const os =
		ua.match(
			/\((?:[^;)]*; )?([^;)]*(Windows|Mac OS X|Android|iPhone|Linux)[^;)]*)/,
		)?.[2] ?? "";
	return os ? `${browser} · ${os}` : browser;
}

export const SessionsCard: React.FC = () => {
	const { i18n } = useLingui();
	const queryClient = useQueryClient();
	const sessions = useQuery(sessionsQueryOptions);
	const refresh = () =>
		queryClient.invalidateQueries({ queryKey: sessionsQueryOptions.queryKey });
	const revoke = useAppMutation({
		mutationFn: async (id: string) => await revokeSessionFn({ data: { id } }),
		success: i18n._("Session signed out"),
		onSuccess: refresh,
	});
	const revokeOthers = useAppMutation({
		mutationFn: async () => await revokeOtherSessionsFn(),
		success: (data) =>
			i18n._("{count} other sessions signed out", { count: data.revoked }),
		onSuccess: refresh,
	});
	const others = (sessions.data ?? []).filter((row) => !row.current).length;

	return (
		<SectionCard
			title={i18n._("Sessions")}
			description={i18n._(
				"Browsers signed in to your account. Changing your password signs out all the others.",
			)}
			actions={
				<Button
					size="xs"
					variant="light"
					color="red"
					disabled={others === 0}
					loading={revokeOthers.isPending}
					onClick={() =>
						modals.openConfirmModal({
							title: i18n._("Sign out everywhere else"),
							centered: true,
							children: (
								<Text size="sm">
									{i18n._("Every other session is signed out right away.")}
								</Text>
							),
							labels: { confirm: i18n._("Sign out"), cancel: i18n._("Cancel") },
							confirmProps: { color: "red" },
							onConfirm: () => revokeOthers.mutate(),
						})
					}
				>
					{i18n._("Sign out everywhere else")}
				</Button>
			}
			flush
		>
			<DataTable
				rows={sessions.data ?? []}
				loading={sessions.isLoading}
				getRowKey={(row) => row.id}
				columns={[
					{
						key: "device",
						header: i18n._("Device"),
						render: (row) => (
							// Group, not Text: a Badge (div) inside a <p> breaks hydration.
							<Group gap={6} wrap="nowrap" title={row.userAgent ?? undefined}>
								<Text size="sm">{describeUserAgent(row.userAgent)}</Text>
								{row.current && (
									<Badge size="xs" variant="light" color="green">
										{i18n._("This browser")}
									</Badge>
								)}
							</Group>
						),
					},
					{
						key: "ip",
						header: i18n._("IP address"),
						render: (row) => row.ip ?? "—",
					},
					{
						key: "lastSeen",
						header: i18n._("Last active"),
						hideOnMobile: true,
						render: (row) => <LocalDate value={row.lastSeenAt} />,
					},
					{
						key: "created",
						header: i18n._("Signed in"),
						hideOnMobile: true,
						render: (row) => <LocalDate value={row.createdAt} />,
					},
					{
						key: "actions",
						header: "",
						align: "right",
						render: (row) =>
							row.current ? null : (
								<Button
									size="xs"
									variant="subtle"
									color="red"
									loading={revoke.isPending && revoke.variables === row.id}
									onClick={() => revoke.mutate(row.id)}
								>
									{i18n._("Sign out")}
								</Button>
							),
					},
				]}
			/>
		</SectionCard>
	);
};
