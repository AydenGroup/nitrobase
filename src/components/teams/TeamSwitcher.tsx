import { useLingui } from "@lingui/react";
import {
	Badge,
	Button,
	Group,
	Menu,
	Modal,
	Stack,
	Text,
	TextInput,
	UnstyledButton,
} from "@mantine/core";
import { schemaResolver, useForm } from "@mantine/form";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { Check, ChevronsUpDown, Plus, Users } from "lucide-react";
import { useState } from "react";
import { roles } from "#/config/permissions.ts";
import { teamDisplayName } from "#/features/teams/labels.ts";
import { CreateTeamSchema } from "#/features/teams/schema.ts";
import {
	createTeamFn,
	switchTeamFn,
} from "#/features/teams/teams.functions.ts";
import { teamContextQueryOptions } from "#/features/teams/teams.query.ts";
import { LocalizedLink } from "#/libs/i18n.ts";
import { useAppMutation } from "../ui/useAppMutation";

/**
 * Sidebar team switcher: shows the active team and the role in it, lists
 * the other teams and creates new ones. Switching reloads every query,
 * since all data is scoped to the active team.
 */
export const TeamSwitcher: React.FC<{ onNavigate?: () => void }> = ({
	onNavigate,
}) => {
	const { i18n } = useLingui();
	const router = useRouter();
	const queryClient = useQueryClient();
	const { data } = useQuery(teamContextQueryOptions);
	const [creating, setCreating] = useState(false);

	const reload = async () => {
		// Everything cached belongs to the previous team.
		queryClient.clear();
		await router.navigate({ to: "/{-$locale}", replace: true });
		await router.invalidate();
		onNavigate?.();
	};
	const switchTeam = useAppMutation({
		mutationFn: (teamId: string) => switchTeamFn({ data: teamId }),
		onSuccess: reload,
	});
	const form = useForm({
		mode: "controlled",
		initialValues: { name: "" },
		validate: schemaResolver(CreateTeamSchema(i18n), { sync: true }),
	});
	const create = useAppMutation({
		mutationFn: (values: { name: string }) => createTeamFn({ data: values }),
		form,
		success: i18n._("Team created"),
		onSuccess: async () => {
			setCreating(false);
			form.reset();
			await reload();
		},
	});

	if (!data) return null;
	const { team, teams, canCreateTeam } = data;

	return (
		<>
			<Menu width={240} position="bottom-start" withinPortal>
				<Menu.Target>
					<UnstyledButton
						w="100%"
						px="xs"
						py={6}
						bdrs="md"
						aria-label={i18n._("Switch team")}
						style={{ border: "1px solid var(--mantine-color-default-border)" }}
					>
						<Group gap="xs" wrap="nowrap">
							<Users size={16} strokeWidth={1.6} />
							<div style={{ flex: 1, minWidth: 0 }}>
								<Text size="sm" fw={600} truncate>
									{teamDisplayName(i18n, team.name)}
								</Text>
								<Text size="xs" c="dimmed">
									{i18n._(roles[team.role].label)}
								</Text>
							</div>
							<ChevronsUpDown size={14} />
						</Group>
					</UnstyledButton>
				</Menu.Target>
				<Menu.Dropdown>
					<Menu.Label>{i18n._("Teams")}</Menu.Label>
					{teams.map((item) => (
						<Menu.Item
							key={item.id}
							onClick={() => item.id !== team.id && switchTeam.mutate(item.id)}
							disabled={switchTeam.isPending}
							rightSection={
								item.id === team.id ? <Check size={14} /> : undefined
							}
						>
							<Group gap={6} wrap="nowrap">
								<Text size="sm" truncate>
									{teamDisplayName(i18n, item.name)}
								</Text>
								{/* A never-named personal team already reads "Personal". */}
								{item.personal && item.name && (
									<Badge size="xs" variant="light" color="gray">
										{i18n._("Personal")}
									</Badge>
								)}
							</Group>
						</Menu.Item>
					))}
					<Menu.Divider />
					<Menu.Item
						component={LocalizedLink}
						to="/settings/team"
						leftSection={<Users size={14} />}
						onClick={onNavigate}
					>
						{i18n._("Team settings")}
					</Menu.Item>
					{canCreateTeam && (
						<Menu.Item
							leftSection={<Plus size={14} />}
							onClick={() => setCreating(true)}
						>
							{i18n._("Create team")}
						</Menu.Item>
					)}
				</Menu.Dropdown>
			</Menu>
			<Modal
				opened={creating}
				onClose={() => setCreating(false)}
				title={i18n._("Create team")}
			>
				<form onSubmit={form.onSubmit((values) => create.mutate(values))}>
					<Stack>
						<TextInput
							label={i18n._("Team name")}
							data-autofocus
							{...form.getInputProps("name")}
						/>
						<Text size="xs" c="dimmed">
							{i18n._(
								"You become the owner. Servers, apps and backups are separate per team.",
							)}
						</Text>
						<Group justify="flex-end">
							<Button type="submit" loading={create.isPending}>
								{i18n._("Create team")}
							</Button>
						</Group>
					</Stack>
				</form>
			</Modal>
		</>
	);
};
