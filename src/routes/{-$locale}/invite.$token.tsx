import { useLingui } from "@lingui/react";
import {
	Alert,
	Anchor,
	Button,
	Divider,
	Stack,
	Text,
	Title,
} from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { RegisterForm } from "#/components/auth/RegisterForm.tsx";
import { useAppMutation } from "#/components/ui/useAppMutation";
import { roles } from "#/config/permissions.ts";
import { APP_NAME } from "#/config/shared.ts";
import { teamDisplayName } from "#/features/teams/labels.ts";
import {
	acceptInviteFn,
	previewInviteFn,
} from "#/features/teams/teams.functions.ts";
import { AuthLayout } from "#/layouts/AuthLayout.tsx";
import { LocalizedLink } from "#/libs/i18n.ts";
import { formatDate } from "#/libs/intl.ts";
import { getAppErrorMessage } from "#/utils/error.ts";

/**
 * Invite link. Signed in: join the team. Signed out: create an account
 * (sign-up is invite-only after the first account) or sign in first and
 * come back to this link.
 */
export const Route = createFileRoute("/{-$locale}/invite/$token")({
	loader: ({ context }) => ({ crumb: context.i18n._("Invite") }),
	component: InvitePage,
});

function InvitePage() {
	const { i18n } = useLingui();
	const { token } = Route.useParams();
	const { user } = Route.useRouteContext();
	const router = useRouter();
	const queryClient = useQueryClient();
	const preview = useQuery({
		queryKey: ["invite", token],
		queryFn: () => previewInviteFn({ data: token }),
		retry: false,
	});
	const accept = useAppMutation({
		mutationFn: () => acceptInviteFn({ data: token }),
		success: i18n._("You joined the team"),
		onSuccess: async () => {
			queryClient.clear();
			await router.navigate({ to: "/{-$locale}", replace: true });
		},
	});

	if (preview.isLoading) return <AuthLayout>{null}</AuthLayout>;
	if (preview.error || !preview.data) {
		return (
			<AuthLayout>
				<Stack gap="md">
					<Title order={2}>{i18n._("Invite")}</Title>
					<Alert color="red">
						{preview.error
							? getAppErrorMessage(i18n, preview.error)
							: i18n._(
									"This invite link is invalid, expired or was already used.",
								)}
					</Alert>
					<Anchor component={LocalizedLink} to="/{-$locale}/login">
						{i18n._("Sign in")}
					</Anchor>
				</Stack>
			</AuthLayout>
		);
	}
	const invite = preview.data;
	const teamName = teamDisplayName(i18n, invite.teamName);
	const invitedBy = (
		<Text size="sm">
			{invite.inviterName
				? i18n._("{inviter} invited you to the team “{team}” on {appName}.", {
						appName: APP_NAME,
						inviter: invite.inviterName,
						team: teamName,
					})
				: i18n._("You are invited to the team “{team}” on {appName}.", {
						appName: APP_NAME,
						team: teamName,
					})}
		</Text>
	);
	const summary = (
		<Text c="dimmed" size="sm">
			{i18n._("Role: {role}. The link expires {date}.", {
				role: i18n._(roles[invite.role].label),
				date: formatDate(i18n.locale, invite.expiresAt),
			})}
		</Text>
	);

	if (user) {
		return (
			<AuthLayout>
				<Stack gap="md">
					<Title order={2}>
						{i18n._("Join the team “{team}”", { team: teamName })}
					</Title>
					{invitedBy}
					{summary}
					{invite.email && invite.email !== user.email.toLowerCase() && (
						<Alert color="orange">
							{i18n._(
								"This invite is for {email}. You are signed in as {current}.",
								{ email: invite.email, current: user.email },
							)}
						</Alert>
					)}
					<Button onClick={() => accept.mutate()} loading={accept.isPending}>
						{i18n._("Join team")}
					</Button>
				</Stack>
			</AuthLayout>
		);
	}

	return (
		<AuthLayout>
			<Stack gap="lg">
				{invitedBy}
				{summary}
				<RegisterForm invite={{ token, email: invite.email, teamName }} />
				<Divider label={i18n._("Already have an account?")} />
				<Button
					variant="default"
					component={LocalizedLink}
					to="/{-$locale}/login"
					search={{ redirect: router.history.location.href }}
				>
					{i18n._("Sign in, then join")}
				</Button>
			</Stack>
		</AuthLayout>
	);
}
