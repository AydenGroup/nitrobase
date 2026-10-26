import { useLingui } from "@lingui/react";
import { NavLink, Stack, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "@tanstack/react-router";
import { StatusDot } from "#/components/ui/StatusBadge";
import { DATABASE_TEMPLATE_ID } from "#/config/database-engines.ts";
import { POLL_MS } from "#/config/polling.ts";
import { appStatuses } from "#/config/status.ts";
import { appsQueryOptions } from "#/features/apps/apps.query.ts";
import { duplicateNames } from "#/libs/format.ts";
import { LocalizedLink, stripLocale } from "#/libs/i18n";
import { AppUpdateBadge } from "./AppUpdateBadge";
import { useAppUpdates } from "./useAppUpdates";

/** Sidebar list of the user's apps with a live status dot. */
export const AppsNavList: React.FC<{ onNavigate?: () => void }> = ({
	onNavigate,
}) => {
	const { i18n } = useLingui();
	const { pathname } = useLocation();
	const current = stripLocale(pathname);
	const updates = useAppUpdates();
	const { data: all = [] } = useQuery({
		...appsQueryOptions,
		refetchInterval: POLL_MS.background,
	});
	// Databases have their own section (Data → Databases).
	const apps = all.filter((app) => app.templateId !== DATABASE_TEMPLATE_ID);
	if (apps.length === 0) {
		return (
			<Text size="xs" c="dimmed" px="sm" py={4}>
				{i18n._("No apps yet")}
			</Text>
		);
	}
	const duplicates = duplicateNames(apps);
	return (
		<Stack gap={1}>
			{apps.map((app) => (
				<NavLink
					key={app.id}
					component={LocalizedLink}
					to={`/apps/${app.id}`}
					label={app.name}
					description={
						duplicates.has(app.name.trim().toLowerCase())
							? app.folder
							: undefined
					}
					active={current.startsWith(`/apps/${app.id}`)}
					onClick={onNavigate}
					py={4}
					bdrs="md"
					leftSection={<StatusDot meta={appStatuses[app.status]} />}
					rightSection={<AppUpdateBadge update={updates.get(app.id)} compact />}
				/>
			))}
		</Stack>
	);
};
