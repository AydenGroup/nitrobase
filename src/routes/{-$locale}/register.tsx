import { useLingui } from "@lingui/react";
import { Alert, Anchor, SegmentedControl, Stack, Title } from "@mantine/core";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { RegisterForm } from "#/components/auth/RegisterForm.tsx";
import { RestoreSelfBackupForm } from "#/components/auth/RestoreSelfBackupForm.tsx";
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
					<Alert color="blue" variant="light">
						{i18n._(
							"Setting up needs the one-time setup token. The installer printed it (SETUP_TOKEN in the install's .env); otherwise the panel printed it in its logs: run docker compose logs app on the server.",
						)}
					</Alert>
					<SegmentedControl
						fullWidth
						value={mode}
						onChange={(value) => setMode(value as "create" | "restore")}
						data={[
							{ value: "create", label: i18n._("Create the administrator") },
							{ value: "restore", label: i18n._("Restore from a backup") },
						]}
					/>
					{mode === "create" ? <RegisterForm /> : <RestoreSelfBackupForm />}
				</Stack>
			)}
		</AuthLayout>
	);
}
