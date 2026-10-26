import { useLingui } from "@lingui/react";
import { Alert, Button, Group, Text } from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import { useState } from "react";
import { useCan } from "#/components/teams/useCan";
import { useAppMutation } from "#/components/ui/useAppMutation";
import { STALE_MS } from "#/config/polling.ts";
import { APP_NAME } from "#/config/shared.ts";
import {
	getInstanceStateFn,
	resumeInstanceFn,
} from "#/features/settings/settings.functions.ts";

const instanceStateQuery = {
	queryKey: ["instance-state"],
	queryFn: () => getInstanceStateFn(),
	staleTime: STALE_MS.medium,
};

/**
 * Split-brain guard: when this database belongs to another installation
 * (restored self-backup, cloned DB), background work is paused. Instance
 * admins choose "resume here" (this machine takes over) or keep it paused.
 */
export const InstancePausedBanner: React.FC = () => {
	const { i18n } = useLingui();
	const can = useCan();
	const queryClient = useQueryClient();
	const [dismissed, setDismissed] = useState(false);
	const { data } = useQuery(instanceStateQuery);
	const resume = useAppMutation({
		mutationFn: () => resumeInstanceFn(),
		success: i18n._(
			"Resumed: this installation now runs jobs, schedules and monitoring.",
		),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: ["instance-state"] }),
	});
	if (!data?.paused || dismissed) return null;
	return (
		<Alert
			color="orange"
			icon={<TriangleAlert size={18} />}
			title={i18n._("This database was moved")}
			mb="md"
		>
			<Text size="sm" mb="sm">
				{i18n._(
					"It belongs to another {appName} installation (a restored self-backup or a copied database). Job recovery, schedules, monitoring and new jobs are paused so two panels never drive the same servers. Resume here only if the old installation is stopped for good.",
					{ appName: APP_NAME },
				)}
			</Text>
			{can("instance.manage") ? (
				<Group gap="xs">
					<Button
						color="orange"
						size="xs"
						loading={resume.isPending}
						onClick={() => resume.mutate()}
					>
						{i18n._("This database was moved — resume here")}
					</Button>
					<Button
						variant="default"
						size="xs"
						onClick={() => setDismissed(true)}
					>
						{i18n._("Keep paused")}
					</Button>
				</Group>
			) : (
				<Text size="sm" c="dimmed">
					{i18n._("Ask an instance administrator to resume it.")}
				</Text>
			)}
		</Alert>
	);
};
