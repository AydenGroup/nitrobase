import { useLingui } from "@lingui/react";
import { Button } from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";
import type { useAppJob } from "#/components/apps/useAppJob";
import { useCan } from "#/components/teams/useCan";
import { SectionCard } from "#/components/ui/SectionCard";
import type { AppOverview } from "#/features/apps/schema.ts";
import { appDatabaseLinksQueryOptions } from "#/features/databases/databases.query.ts";
import { DatabaseLinksTable } from "./DatabaseLinks";
import { LinkDatabaseModal } from "./LinkDatabaseModal";

/** App page: the databases this app is linked to (link / unlink). */
export const AppDatabaseLinksCard: React.FC<{
	overview: AppOverview;
	jobs: ReturnType<typeof useAppJob>;
}> = ({ overview, jobs }) => {
	const { i18n } = useLingui();
	const can = useCan();
	const queryClient = useQueryClient();
	const [open, setOpen] = useState(false);
	const links = useQuery(appDatabaseLinksQueryOptions(overview.app.id));
	if (!can("database.view")) return null;
	const rows = links.data ?? [];
	const linkButton = can("database.manage") ? (
		<Button
			size="xs"
			variant="light"
			leftSection={<Plus size={14} />}
			onClick={() => setOpen(true)}
		>
			{i18n._("Link a database")}
		</Button>
	) : null;
	const started = (id: string, title: string) => {
		jobs.openJob(id, title);
		queryClient.invalidateQueries({ queryKey: ["databases"] });
		queryClient.invalidateQueries({
			queryKey: ["apps", overview.app.id, "database-links"],
		});
	};
	return (
		<SectionCard
			title={i18n._("Databases")}
			actions={rows.length > 0 ? linkButton : undefined}
			flush
		>
			<DatabaseLinksTable
				links={rows}
				side="app"
				onJob={started}
				emptyAction={linkButton}
			/>
			<LinkDatabaseModal
				opened={open}
				onClose={() => setOpen(false)}
				serverId={overview.server.id}
				app={{ id: overview.app.id, name: overview.app.name }}
				linkedIds={rows.map((link) => link.databaseId)}
				onStarted={(id) => started(id, i18n._("Link database"))}
			/>
		</SectionCard>
	);
};
