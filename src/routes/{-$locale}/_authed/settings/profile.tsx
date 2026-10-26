import { useLingui } from "@lingui/react";
import { Stack } from "@mantine/core";
import { createFileRoute } from "@tanstack/react-router";
import { ProfileForm } from "#/components/auth/ProfileForm.tsx";
import { PageHeader } from "#/components/ui/PageHeader";

/** Profile settings page; the loader only supplies the localized breadcrumb. */
export const Route = createFileRoute("/{-$locale}/_authed/settings/profile")({
	loader: async ({ context }) => {
		const { i18n } = context;
		return {
			crumb: i18n._("Profile"),
		};
	},
	component: RouteComponent,
});

function RouteComponent() {
	const { i18n } = useLingui();
	return (
		<Stack gap="lg">
			<PageHeader
				title={i18n._("Profile")}
				description={i18n._("Update your account information and avatar.")}
			/>
			<ProfileForm />
		</Stack>
	);
}
