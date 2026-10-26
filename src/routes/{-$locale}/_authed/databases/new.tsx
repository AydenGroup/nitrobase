import { useLingui } from "@lingui/react";
import { Stack } from "@mantine/core";
import { createFileRoute } from "@tanstack/react-router";
import { CreateDatabaseForm } from "#/components/databases/CreateDatabaseForm";
import { PageHeader } from "#/components/ui/PageHeader";
import { serversQueryOptions } from "#/features/servers/servers.query.ts";

export const Route = createFileRoute("/{-$locale}/_authed/databases/new")({
	loader: async ({ context }) => {
		await context.queryClient.query(serversQueryOptions).catch(() => null);
		return { crumb: context.i18n._("New database") };
	},
	component: NewDatabase,
});

function NewDatabase() {
	const { i18n } = useLingui();
	return (
		<Stack gap="lg">
			<PageHeader
				title={i18n._("New database")}
				description={i18n._(
					"Runs on one of your servers with a generated password, backups and a private network to the apps you link.",
				)}
			/>
			<CreateDatabaseForm />
		</Stack>
	);
}
