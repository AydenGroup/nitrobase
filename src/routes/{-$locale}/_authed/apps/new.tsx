import { useLingui } from "@lingui/react";
import { Button, Group, Stack } from "@mantine/core";
import { createFileRoute } from "@tanstack/react-router";
import { CloudDownload } from "lucide-react";
import { useState } from "react";
import { z } from "zod";
import { DeployWizard } from "#/components/apps/DeployWizard";
import { CloudImportModal } from "#/components/cloud-sync/CloudImportModal";
import { useCan } from "#/components/teams/useCan";
import { PageHeader } from "#/components/ui/PageHeader";
import {
	type CloudSyncProvider,
	cloudSyncProviders,
	partsFor,
} from "#/config/cloud-sync.ts";
import { serversQueryOptions } from "#/features/servers/servers.query.ts";
import { templatesQueryOptions } from "#/features/templates/templates.query.ts";

export const Route = createFileRoute("/{-$locale}/_authed/apps/new")({
	validateSearch: z.object({ template: z.string().optional() }),
	loader: async ({ context }) => {
		await Promise.all([
			context.queryClient.query(templatesQueryOptions),
			context.queryClient.query(serversQueryOptions),
		]);
		return { crumb: context.i18n._("New app") };
	},
	component: NewApp,
});

/** Providers a new app can be imported from. */
const importProviders = cloudSyncProviders.filter(
	(provider) => partsFor(provider, "import").length > 0,
);

function NewApp() {
	const { i18n } = useLingui();
	const { template } = Route.useSearch();
	const canSync = useCan()("app.sync");
	const [importing, setImporting] = useState<CloudSyncProvider | null>(null);
	return (
		<Stack gap="lg">
			<PageHeader
				title={i18n._("New app")}
				description={i18n._("Deploy an app from a template")}
				actions={
					canSync &&
					importProviders.length > 0 && (
						<Group gap="xs">
							{importProviders.map((provider) => (
								<Button
									key={provider.id}
									variant="light"
									leftSection={<CloudDownload size={16} />}
									onClick={() => setImporting(provider)}
								>
									{i18n._(provider.importLabel)}
								</Button>
							))}
						</Group>
					)
				}
			/>
			<DeployWizard initialTemplateId={template} />
			{importing && (
				<CloudImportModal
					provider={importing}
					opened={importing !== null}
					onClose={() => setImporting(null)}
				/>
			)}
		</Stack>
	);
}
