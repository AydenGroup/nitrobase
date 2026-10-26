import { useLingui } from "@lingui/react";
import { Button, Group, NumberInput, Stack, Switch, Text } from "@mantine/core";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { SectionCard } from "#/components/ui/SectionCard";
import { useAppMutation } from "#/components/ui/useAppMutation";
import type { ServerDTO } from "#/features/servers/schema.ts";
import { updateServerResourcePolicyFn } from "#/features/servers/servers.functions.ts";

/** Server → Settings → Resource limits: require limits on every app service. */
export const ResourcePolicyCard: React.FC<{
	server: ServerDTO;
	busy: boolean;
}> = ({ server, busy }) => {
	const { i18n } = useLingui();
	const queryClient = useQueryClient();
	const [requireLimits, setRequireLimits] = useState(server.requireLimits);
	const [defaultMemoryMb, setDefaultMemoryMb] = useState<number | null>(
		server.defaultMemoryMb,
	);
	useEffect(() => {
		setRequireLimits(server.requireLimits);
		setDefaultMemoryMb(server.defaultMemoryMb);
	}, [server.requireLimits, server.defaultMemoryMb]);
	const save = useAppMutation({
		mutationFn: async () =>
			await updateServerResourcePolicyFn({
				data: { serverId: server.id, requireLimits, defaultMemoryMb },
			}),
		success: i18n._("Resource policy saved"),
		field: "policy",
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ["servers"] }),
	});
	const changed =
		requireLimits !== server.requireLimits ||
		defaultMemoryMb !== server.defaultMemoryMb;

	return (
		<SectionCard
			title={i18n._("Resource limits")}
			description={i18n._(
				"Make every app on this server run with a memory limit, so one app cannot take the memory of the others.",
			)}
		>
			<Stack gap="sm">
				<Switch
					label={i18n._("Require a memory limit on every app service")}
					checked={requireLimits}
					onChange={(event) => setRequireLimits(event.currentTarget.checked)}
				/>
				<NumberInput
					label={i18n._("Default memory limit (MiB)")}
					description={i18n._(
						"Given to services without a limit. Empty: such deploys are refused until a limit is set in the app's settings.",
					)}
					placeholder={i18n._("None")}
					min={16}
					step={128}
					w={260}
					disabled={!requireLimits}
					value={defaultMemoryMb ?? ""}
					onChange={(value) =>
						setDefaultMemoryMb(
							typeof value === "number" && value > 0 ? value : null,
						)
					}
				/>
				<Text size="xs" c="dimmed">
					{i18n._(
						"Running apps are not changed: the policy applies on their next deploy, and removing a limit is refused while it is on.",
					)}
				</Text>
				{save.fieldError() && (
					<Text size="sm" c="red">
						{save.fieldError()}
					</Text>
				)}
				<Group justify="flex-end">
					<Button
						disabled={!changed || busy}
						loading={save.isPending}
						onClick={() => save.mutate()}
					>
						{i18n._("Save")}
					</Button>
				</Group>
			</Stack>
		</SectionCard>
	);
};
