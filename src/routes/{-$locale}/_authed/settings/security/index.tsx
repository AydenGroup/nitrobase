import { useLingui } from "@lingui/react";
import { Stack } from "@mantine/core";
import { createFileRoute } from "@tanstack/react-router";
import { SessionsCard } from "#/components/security/SessionsCard";
import { TwoFactorCard } from "#/components/security/TwoFactorCard";
import { PageHeader } from "#/components/ui/PageHeader";
import {
	sessionsQueryOptions,
	twoFactorStatusQueryOptions,
} from "#/features/auth/security.query.ts";

export const Route = createFileRoute("/{-$locale}/_authed/settings/security/")({
	loader: async ({ context }) => {
		await Promise.all([
			context.queryClient.query(twoFactorStatusQueryOptions).catch(() => null),
			context.queryClient.query(sessionsQueryOptions).catch(() => null),
		]);
		return { crumb: context.i18n._("Security") };
	},
	component: Page,
});

function Page() {
	const { i18n } = useLingui();
	return (
		<Stack gap="lg">
			<PageHeader
				title={i18n._("Security")}
				description={i18n._("Two-factor authentication and active sessions.")}
			/>
			<TwoFactorCard />
			<SessionsCard />
		</Stack>
	);
}
