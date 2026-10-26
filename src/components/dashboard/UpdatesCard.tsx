import { useLingui } from "@lingui/react";
import { Anchor, Button, Group, Stack, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpCircle } from "lucide-react";
import { useState } from "react";
import { AppUpdateBadge } from "#/components/apps/AppUpdateBadge";
import { BulkUpdateModal } from "#/components/apps/BulkUpdateModal";
import { useAppUpdates } from "#/components/apps/useAppUpdates";
import { useCan } from "#/components/teams/useCan";
import { SectionCard } from "#/components/ui/SectionCard";
import { DATABASE_TEMPLATE_ID } from "#/config/database-engines.ts";
import { appsQueryOptions } from "#/features/apps/apps.query.ts";
import { LocalizedLink } from "#/libs/i18n.ts";

/** Dashboard: apps and databases with a newer version, "Update all". */
export const UpdatesCard: React.FC = () => {
	const { i18n } = useLingui();
	const can = useCan();
	const { data: apps = [] } = useQuery(appsQueryOptions);
	const updates = useAppUpdates();
	const [open, setOpen] = useState(false);
	const pending = apps.flatMap((app) => {
		const update = updates.get(app.id);
		return update?.available ? [{ app, update }] : [];
	});
	if (pending.length === 0) return null;
	return (
		<SectionCard
			title={i18n._("Updates available")}
			description={i18n._(
				"{count, plural, one {# app has} other {# apps have}} a newer version.",
				{ count: pending.length },
			)}
			actions={
				can("app.deploy") && (
					<Button
						size="xs"
						leftSection={<ArrowUpCircle size={14} />}
						onClick={() => setOpen(true)}
					>
						{i18n._("Update all")}
					</Button>
				)
			}
		>
			<Stack gap={6}>
				{pending.map(({ app, update }) => (
					<Group key={app.id} justify="space-between" wrap="nowrap">
						<Anchor
							component={LocalizedLink}
							to={
								app.templateId === DATABASE_TEMPLATE_ID
									? `/databases/${app.id}`
									: `/apps/${app.id}`
							}
							size="sm"
						>
							{app.name}
						</Anchor>
						<Group gap="xs" wrap="nowrap">
							<Text size="xs" c="dimmed">
								{update.current} → {update.name ?? update.version}
							</Text>
							<AppUpdateBadge update={update} compact />
						</Group>
					</Group>
				))}
			</Stack>
			<BulkUpdateModal
				opened={open}
				onClose={() => setOpen(false)}
				apps={pending.map(({ app, update }) => ({
					id: app.id,
					name: app.name,
					update,
				}))}
			/>
		</SectionCard>
	);
};
