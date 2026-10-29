import { useLingui } from "@lingui/react";
import {
	ActionIcon,
	Alert,
	Badge,
	Button,
	Checkbox,
	Group,
	Select,
	Stack,
	Text,
	TextInput,
	Tooltip,
} from "@mantine/core";
import { schemaResolver, useForm } from "@mantine/form";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { Link2, Trash2, UserMinus } from "lucide-react";
import { useState } from "react";
import { UserAvatar } from "#/components/auth/UserAvatar";
import { ConfirmDanger } from "#/components/ui/ConfirmDanger";
import { CopyField } from "#/components/ui/CopyField";
import { DataTable } from "#/components/ui/DataTable";
import { SectionCard } from "#/components/ui/SectionCard";
import { useAppMutation } from "#/components/ui/useAppMutation";
import {
	permissionGroupLabels,
	permissions,
	type RoleDefinition,
	type RoleId,
	roleIds,
	roles,
	teamPermissionIds,
} from "#/config/permissions.ts";
import { EXAMPLES } from "#/config/shared.ts";
import { teamDisplayName } from "#/features/teams/labels.ts";
import {
	type CreatedInvite,
	type MemberDTO,
	RenameTeamSchema,
} from "#/features/teams/schema.ts";
import {
	changeMemberRoleFn,
	createInviteFn,
	deleteTeamFn,
	leaveTeamFn,
	removeMemberFn,
	renameTeamFn,
	revokeInviteFn,
} from "#/features/teams/teams.functions.ts";
import {
	invitesQueryOptions,
	membersQueryOptions,
	teamContextQueryOptions,
} from "#/features/teams/teams.query.ts";
import { localizedHref } from "#/libs/i18n.ts";
import { formatDate } from "#/libs/intl.ts";
import { useCan } from "./useCan";

const rank = (role: RoleId) => (roles[role] as RoleDefinition).rank;

/** Roles the current member may hand out: never above their own. */
function useGrantableRoles(): RoleId[] {
	const { data } = useQuery(teamContextQueryOptions);
	const own = data ? rank(data.team.role) : 0;
	return roleIds.filter((role) => rank(role) <= own);
}

export const TeamOverviewCard: React.FC = () => {
	const { i18n } = useLingui();
	const can = useCan();
	const queryClient = useQueryClient();
	const { data } = useQuery(teamContextQueryOptions);
	const form = useForm({
		mode: "controlled",
		initialValues: { name: data ? teamDisplayName(i18n, data.team.name) : "" },
		validate: schemaResolver(RenameTeamSchema(i18n), { sync: true }),
	});
	const rename = useAppMutation({
		mutationFn: (values: { name: string }) => renameTeamFn({ data: values }),
		form,
		success: i18n._("Team renamed"),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: ["team-context"] }),
	});
	if (!data) return null;
	return (
		<SectionCard
			title={i18n._("Team")}
			description={i18n._(
				"Servers, SSH keys, apps, backups and notification channels belong to the team. Your role: {role}.",
				{ role: i18n._(roles[data.team.role].label) },
			)}
		>
			<form onSubmit={form.onSubmit((values) => rename.mutate(values))}>
				<Group align="flex-end">
					<TextInput
						label={i18n._("Team name")}
						disabled={!can("team.manage")}
						style={{ flex: 1, maxWidth: 420 }}
						{...form.getInputProps("name")}
					/>
					{can("team.manage") && (
						<Button
							type="submit"
							variant="default"
							loading={rename.isPending}
							disabled={!form.isDirty()}
						>
							{i18n._("Save")}
						</Button>
					)}
				</Group>
			</form>
		</SectionCard>
	);
};

export const MembersCard: React.FC = () => {
	const { i18n } = useLingui();
	const can = useCan();
	const router = useRouter();
	const queryClient = useQueryClient();
	const grantable = useGrantableRoles();
	const { data: members = [], isLoading } = useQuery(membersQueryOptions);
	const [leaving, setLeaving] = useState(false);
	const { data: context } = useQuery(teamContextQueryOptions);
	const ownRank = context ? rank(context.team.role) : 0;

	const refresh = () => queryClient.invalidateQueries({ queryKey: ["team"] });
	const changeRole = useAppMutation({
		mutationFn: (data: { userId: string; role: RoleId }) =>
			changeMemberRoleFn({ data }),
		success: i18n._("Role changed"),
		onSuccess: refresh,
	});
	const remove = useAppMutation({
		mutationFn: (userId: string) => removeMemberFn({ data: userId }),
		success: i18n._("Member removed"),
		onSuccess: refresh,
	});
	const leave = useAppMutation({
		mutationFn: () => leaveTeamFn(),
		success: i18n._("You left the team"),
		onSuccess: async () => {
			queryClient.clear();
			await router.navigate({ to: "/{-$locale}", replace: true });
			await router.invalidate();
		},
	});

	const manageable = (member: MemberDTO) =>
		can("members.manage") && !member.you && rank(member.role) <= ownRank;

	return (
		<SectionCard
			title={i18n._("Members")}
			description={i18n._(
				"Roles decide what each member can do. Nobody can grant a role above their own.",
			)}
			actions={
				<Button
					variant="default"
					color="red"
					size="xs"
					onClick={() => setLeaving(true)}
				>
					{i18n._("Leave team")}
				</Button>
			}
			flush
		>
			<DataTable
				loading={isLoading}
				rows={members}
				getRowKey={(member) => member.userId}
				minWidth={560}
				columns={[
					{
						key: "member",
						header: i18n._("Member"),
						render: (member) => (
							<Group gap="sm" wrap="nowrap">
								<UserAvatar user={member} radius="xl" size="sm" />
								<div style={{ minWidth: 0 }}>
									<Text size="sm" fw={500} truncate component="div">
										{member.firstName} {member.lastName}
										{member.you && (
											<Badge ml={6} size="xs" variant="light">
												{i18n._("You")}
											</Badge>
										)}
									</Text>
									<Text size="xs" c="dimmed" truncate>
										{member.email}
									</Text>
								</div>
							</Group>
						),
					},
					{
						key: "role",
						header: i18n._("Role"),
						width: 180,
						render: (member) =>
							manageable(member) ? (
								<Select
									size="xs"
									aria-label={i18n._("Role of {name}", { name: member.email })}
									value={member.role}
									allowDeselect={false}
									data={grantable.map((role) => ({
										value: role,
										label: i18n._(roles[role].label),
									}))}
									onChange={(value) =>
										value &&
										value !== member.role &&
										changeRole.mutate({
											userId: member.userId,
											role: value as RoleId,
										})
									}
								/>
							) : (
								<Badge variant="light">
									{i18n._(roles[member.role].label)}
								</Badge>
							),
					},
					{
						key: "joined",
						header: i18n._("Joined"),
						hideOnMobile: true,
						render: (member) => (
							<Text size="xs" c="dimmed">
								{formatDate(i18n.locale, member.joinedAt, {
									dateStyle: "medium",
								})}
							</Text>
						),
					},
					{
						key: "actions",
						header: "",
						align: "right",
						width: 60,
						render: (member) =>
							manageable(member) ? (
								<Tooltip label={i18n._("Remove from team")}>
									<ActionIcon
										variant="subtle"
										color="red"
										aria-label={i18n._("Remove {name} from the team", {
											name: member.email,
										})}
										loading={
											remove.isPending && remove.variables === member.userId
										}
										onClick={() => remove.mutate(member.userId)}
									>
										<UserMinus size={16} />
									</ActionIcon>
								</Tooltip>
							) : null,
					},
				]}
			/>
			<ConfirmDanger
				opened={leaving}
				onClose={() => setLeaving(false)}
				title={i18n._("Leave team")}
				description={i18n._(
					"You lose access to this team's servers, apps and backups until someone invites you again.",
				)}
				confirmName={context ? teamDisplayName(i18n, context.team.name) : ""}
				confirmLabel={i18n._("Leave team")}
				loading={leave.isPending}
				onConfirm={() => leave.mutate()}
			/>
		</SectionCard>
	);
};

export const InvitesCard: React.FC = () => {
	const { i18n } = useLingui();
	const queryClient = useQueryClient();
	const grantable = useGrantableRoles();
	const { data: invites = [], isLoading } = useQuery(invitesQueryOptions);
	const [created, setCreated] = useState<CreatedInvite | null>(null);
	const form = useForm({
		mode: "controlled",
		initialValues: {
			email: "",
			role: "developer" as RoleId,
			sendEmail: true,
		},
	});
	const create = useAppMutation({
		mutationFn: (values: typeof form.values) =>
			createInviteFn({ data: values }),
		form,
		onSuccess: (result) => {
			setCreated(result);
			form.reset();
			return queryClient.invalidateQueries({ queryKey: ["team", "invites"] });
		},
	});
	const revoke = useAppMutation({
		mutationFn: (id: string) => revokeInviteFn({ data: id }),
		success: i18n._("Invite revoked"),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: ["team", "invites"] }),
	});
	const link =
		created &&
		(created.link ??
			`${window.location.origin}${localizedHref(`/invite/${created.token}`, i18n.locale)}`);

	return (
		<SectionCard
			title={i18n._("Invites")}
			description={i18n._(
				"Invite links work once and expire. Sign-up is only possible through an invite.",
			)}
		>
			<Stack>
				<form onSubmit={form.onSubmit((values) => create.mutate(values))}>
					<Group align="flex-end" wrap="wrap">
						<TextInput
							label={i18n._("Email (optional)")}
							description={i18n._(
								"Leave empty for a link anyone can use once.",
							)}
							placeholder={EXAMPLES.email}
							style={{ flex: 1, minWidth: 220 }}
							{...form.getInputProps("email")}
						/>
						<Select
							label={i18n._("Role")}
							allowDeselect={false}
							data={grantable.map((role) => ({
								value: role,
								label: i18n._(roles[role].label),
							}))}
							w={160}
							{...form.getInputProps("role")}
						/>
						<Button
							type="submit"
							loading={create.isPending}
							leftSection={<Link2 size={16} />}
						>
							{i18n._("Create invite")}
						</Button>
					</Group>
					<Checkbox
						mt="xs"
						label={i18n._(
							"Email the link (uses the team's email notification channel)",
						)}
						disabled={!form.values.email}
						{...form.getInputProps("sendEmail", { type: "checkbox" })}
					/>
				</form>
				<Text size="xs" c="dimmed">
					{i18n._(roles[form.values.role].description)}
				</Text>
				{created && link && (
					<Alert
						color={created.email === "failed" ? "orange" : "green"}
						title={
							created.email === "sent"
								? i18n._("Invite emailed")
								: i18n._("Invite created")
						}
						withCloseButton
						onClose={() => setCreated(null)}
					>
						<Stack gap="xs">
							<Text size="sm">
								{created.email === "failed"
									? i18n._(
											"The email could not be sent. Copy the link and send it yourself; it is shown only once.",
										)
									: created.email === "sent"
										? i18n._(
												"The link was emailed. You can also copy it now; it is shown only once.",
											)
										: i18n._(
												"Copy the link and send it to the person you invite; it is shown only once.",
											)}
							</Text>
							<CopyField value={link} />
						</Stack>
					</Alert>
				)}
				<DataTable
					loading={isLoading}
					rows={invites}
					getRowKey={(invite) => invite.id}
					minWidth={520}
					empty={
						<Text size="sm" c="dimmed" p="md">
							{i18n._("No pending invites.")}
						</Text>
					}
					columns={[
						{
							key: "email",
							header: i18n._("For"),
							render: (invite) => (
								<Text size="sm">
									{invite.email ?? i18n._("Anyone with the link")}
								</Text>
							),
						},
						{
							key: "role",
							header: i18n._("Role"),
							render: (invite) => (
								<Badge variant="light">
									{i18n._(roles[invite.role].label)}
								</Badge>
							),
						},
						{
							key: "expires",
							header: i18n._("Expires"),
							render: (invite) => (
								<Text size="xs" c="dimmed">
									{formatDate(i18n.locale, invite.expiresAt)}
								</Text>
							),
						},
						{
							key: "actions",
							header: "",
							align: "right",
							width: 60,
							render: (invite) => (
								<ActionIcon
									variant="subtle"
									color="red"
									aria-label={i18n._("Revoke invite")}
									onClick={() => revoke.mutate(invite.id)}
								>
									<Trash2 size={16} />
								</ActionIcon>
							),
						},
					]}
				/>
			</Stack>
		</SectionCard>
	);
};

/** What each role may do, from the permission registry. */
export const RolesCard: React.FC = () => {
	const { i18n } = useLingui();
	return (
		<SectionCard title={i18n._("Roles")} flush>
			<DataTable
				rows={teamPermissionIds}
				getRowKey={(id) => id}
				minWidth={640}
				columns={[
					{
						key: "permission",
						header: i18n._("Permission"),
						render: (id) => (
							<div>
								<Text size="sm">{i18n._(permissions[id].label)}</Text>
								<Text size="xs" c="dimmed">
									{i18n._(permissionGroupLabels[permissions[id].group])}
								</Text>
							</div>
						),
					},
					...roleIds.map((role) => ({
						key: role,
						header: i18n._(roles[role].label),
						align: "center" as const,
						width: 90,
						render: (id: (typeof teamPermissionIds)[number]) => {
							const granted = (roles[role] as RoleDefinition).permissions;
							return granted === "all" || granted.includes(id) ? "✓" : "";
						},
					})),
				]}
			/>
		</SectionCard>
	);
};

export const DeleteTeamCard: React.FC = () => {
	const { i18n } = useLingui();
	const router = useRouter();
	const queryClient = useQueryClient();
	const { data } = useQuery(teamContextQueryOptions);
	const [opened, setOpened] = useState(false);
	const remove = useAppMutation({
		mutationFn: () => deleteTeamFn(),
		success: i18n._("Team deleted"),
		onSuccess: async () => {
			queryClient.clear();
			await router.navigate({ to: "/{-$locale}", replace: true });
			await router.invalidate();
		},
	});
	if (!data) return null;
	return (
		<SectionCard
			tone="danger"
			title={i18n._("Delete team")}
			description={i18n._(
				"Possible once the team has no servers, SSH keys or backup destinations left. Members lose access.",
			)}
			actions={
				<Button color="red" variant="light" onClick={() => setOpened(true)}>
					{i18n._("Delete team")}
				</Button>
			}
		>
			<ConfirmDanger
				opened={opened}
				onClose={() => setOpened(false)}
				title={i18n._("Delete team")}
				description={i18n._("This cannot be undone.")}
				confirmName={teamDisplayName(i18n, data.team.name)}
				confirmLabel={i18n._("Delete team")}
				loading={remove.isPending}
				onConfirm={() => remove.mutate()}
			/>
		</SectionCard>
	);
};
