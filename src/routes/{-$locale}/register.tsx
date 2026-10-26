import { useLingui } from "@lingui/react";
import { Alert, Anchor, SegmentedControl, Stack, Title } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { RegisterForm } from "#/components/auth/RegisterForm.tsx";
import { RestoreSelfBackupForm } from "#/components/auth/RestoreSelfBackupForm.tsx";
import { getSetupInfoFn } from "#/features/auth/auth.functions.ts";
import { AuthLayout } from "#/layouts/AuthLayout.tsx";
import { LocalizedLink } from "#/libs/i18n.ts";

/**
 * Sign-up. Open while no account exists (first-run admin, or restoring a
 * Nitrobase self-backup instead); afterwards it explains that sign-up is by
 * invite (`/invite/<token>`). The server enforces this too.
 */
export const Route = createFileRoute("/{-$locale}/register")({
	component: RouteComponent,
});

function RouteComponent() {
	const { i18n } = useLingui();
	const { isSetupComplete } = Route.useRouteContext();
	const [mode, setMode] = useState<"create" | "restore">("create");
	const setup = useQuery({
		queryKey: ["setup-info"],
		queryFn: () => getSetupInfoFn(),
		enabled: !isSetupComplete,
	});
	const tokenRequired = setup.data?.tokenRequired ?? false;
	return (
		<AuthLayout>
			{isSetupComplete ? (
				<Stack gap="md">
					<Title order={2}>{i18n._("Create your account")}</Title>
					<Alert color="blue" variant="light">
						{i18n._(
							"Sign-up is by invite only. Ask a team owner for an invite link.",
						)}
					</Alert>
					<Anchor component={LocalizedLink} to="/{-$locale}/login">
						{i18n._("Already have an account? Sign in")}
					</Anchor>
				</Stack>
			) : (
				<Stack gap="lg">
					{setup.data && !tokenRequired && (
						<Alert color="orange" variant="light">
							{i18n._(
								"No setup token is set: whoever opens this page first becomes the administrator. Set SETUP_TOKEN in the install's .env (the installer does) or create the account right now from a trusted network.",
							)}
						</Alert>
					)}
					<SegmentedControl
						fullWidth
						value={mode}
						onChange={(value) => setMode(value as "create" | "restore")}
						data={[
							{ value: "create", label: i18n._("Create the administrator") },
							{ value: "restore", label: i18n._("Restore from a backup") },
						]}
					/>
					{mode === "create" ? (
						<RegisterForm setupTokenRequired={tokenRequired} />
					) : (
						<RestoreSelfBackupForm tokenRequired={tokenRequired} />
					)}
				</Stack>
			)}
		</AuthLayout>
	);
}
