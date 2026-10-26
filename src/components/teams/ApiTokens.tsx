import { useLingui } from "@lingui/react";
import {
	ActionIcon,
	Alert,
	Badge,
	Button,
	Checkbox,
	Code,
	Group,
	Modal,
	SegmentedControl,
	Select,
	SimpleGrid,
	Stack,
	Text,
	TextInput,
	Tooltip,
} from "@mantine/core";
import { schemaResolver, useForm } from "@mantine/form";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { CopyField } from "#/components/ui/CopyField";
import { DataTable } from "#/components/ui/DataTable";
import { SectionCard } from "#/components/ui/SectionCard";
import { useAppMutation } from "#/components/ui/useAppMutation";
import {
	impliedBy,
	type Permission,
	type PermissionGroup,
	permissionGroupLabels,
	permissions,
	presetPermissions,
	tokenPresets,
	withImplied,
} from "#/config/permissions.ts";
import {
	API_TOKEN_EXPIRY_DAYS,
	type CreateApiTokenInput,
	CreateApiTokenSchema,
	type CreatedApiToken,
	type TokenScope,
	tokenPermissionIds,
} from "#/features/tokens/schema.ts";
import {
	createApiTokenFn,
	revokeApiTokenFn,
} from "#/features/tokens/tokens.functions.ts";
import { apiTokensQueryOptions } from "#/features/tokens/tokens.query.ts";
import { formatDate } from "#/libs/intl.ts";
import { useCan } from "./useCan";

/** Settings → API tokens: list, create (secret shown once), revoke. */
export const ApiTokensCard: React.FC = () => {
	const { i18n } = useLingui();
	const can = useCan();
	const queryClient = useQueryClient();
	const { data: tokens = [], isLoading } = useQuery(apiTokensQueryOptions);
	const [creating, setCreating] = useState(false);
	const [created, setCreated] = useState<CreatedApiToken | null>(null);
	const revoke = useAppMutation({
		mutationFn: (id: string) => revokeApiTokenFn({ data: id }),
		success: i18n._("Token revoked"),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: ["api-tokens"] }),
	});
	const apiBase = typeof window === "undefined" ? "" : window.location.origin;

	return (
		<Stack gap="lg">
			{created && (
				<Alert
					color="green"
					title={i18n._("Token created")}
					withCloseButton
					onClose={() => setCreated(null)}
				>
					<Stack gap="xs">
						<Text size="sm">
							{i18n._(
								"Copy it now: it is shown only once and stored only as a hash.",
							)}
						</Text>
						<CopyField value={created.secret} />
						<Text size="xs" c="dimmed">
							{i18n._("It can: {permissions}", {
								permissions: created.token.permissions
									.map((id) => i18n._(permissions[id].label))
									.join(" · "),
							})}
						</Text>
						<Text size="xs" fw={500}>
							{i18n._("Try it:")}
						</Text>
						<Code block>
							{`curl -H "Authorization: Bearer ${created.secret}" ${apiBase}/api/v1/${created.token.permissions.includes("app.view") ? "apps" : "servers"}`}
						</Code>
					</Stack>
				</Alert>
			)}
			<SectionCard
				title={i18n._("API tokens")}
				description={i18n._(
					"Tokens call the REST API at /api/v1 (OpenAPI description at /api/v1/openapi.json). Personal tokens act as you and never beyond your current role; team tokens belong to the team.",
				)}
				actions={
					<Button
						leftSection={<Plus size={16} />}
						onClick={() => setCreating(true)}
					>
						{i18n._("Create token")}
					</Button>
				}
				flush
			>
				<DataTable
					loading={isLoading}
					rows={tokens}
					getRowKey={(token) => token.id}
					minWidth={720}
					empty={
						<Text size="sm" c="dimmed" p="md">
							{i18n._("No API tokens yet.")}
						</Text>
					}
					columns={[
						{
							key: "name",
							header: i18n._("Name"),
							render: (token) => (
								<div>
									<Text size="sm" fw={500}>
										{token.name}
									</Text>
									<Code>{token.prefix}…</Code>
								</div>
							),
						},
						{
							key: "scope",
							header: i18n._("Scope"),
							render: (token) => (
								<Tooltip
									label={
										token.scope === "personal"
											? i18n._("Acts as {owner}", { owner: token.owner ?? "?" })
											: i18n._("Team token")
									}
								>
									<Badge
										variant="light"
										color={token.scope === "team" ? "grape" : "blue"}
									>
										{token.scope === "team"
											? i18n._("Team")
											: i18n._("Personal")}
									</Badge>
								</Tooltip>
							),
						},
						{
							key: "review",
							header: "",
							width: 80,
							render: (token) =>
								token.creatorCurrent ? null : (
									<Tooltip
										multiline
										w={280}
										label={i18n._(
											"Its creator left the team or no longer holds all of its permissions. Review or revoke it.",
										)}
									>
										<Badge color="orange" variant="light">
											{i18n._("Review")}
										</Badge>
									</Tooltip>
								),
						},
						{
							key: "permissions",
							header: i18n._("Permissions"),
							render: (token) => (
								<Tooltip
									multiline
									w={320}
									label={token.permissions
										.map((id) => i18n._(permissions[id].label))
										.join(" · ")}
								>
									<Text size="sm">
										{i18n._(
											"{count, plural, one {# permission} other {# permissions}}",
											{
												count: token.permissions.length,
											},
										)}
									</Text>
								</Tooltip>
							),
						},
						{
							key: "used",
							header: i18n._("Last used"),
							hideOnMobile: true,
							render: (token) => (
								<Text size="xs" c="dimmed">
									{token.lastUsedAt
										? i18n._("{date} from {ip}", {
												date: formatDate(i18n.locale, token.lastUsedAt),
												ip: token.lastUsedIp ?? "?",
											})
										: i18n._("Never")}
								</Text>
							),
						},
						{
							key: "expires",
							header: i18n._("Expires"),
							render: (token) => (
								<Text size="xs" c="dimmed">
									{token.expiresAt
										? formatDate(i18n.locale, token.expiresAt, {
												dateStyle: "medium",
											})
										: i18n._("Never")}
								</Text>
							),
						},
						{
							key: "actions",
							header: "",
							align: "right",
							width: 60,
							render: (token) =>
								token.scope === "personal" || can("tokens.manage") ? (
									<ActionIcon
										variant="subtle"
										color="red"
										aria-label={i18n._("Revoke {name}", { name: token.name })}
										onClick={() => revoke.mutate(token.id)}
									>
										<Trash2 size={16} />
									</ActionIcon>
								) : null,
						},
					]}
				/>
			</SectionCard>
			<CreateTokenModal
				opened={creating}
				onClose={() => setCreating(false)}
				onCreated={(result) => {
					setCreated(result);
					setCreating(false);
				}}
			/>
		</Stack>
	);
};

const CreateTokenModal: React.FC<{
	opened: boolean;
	onClose: () => void;
	onCreated: (token: CreatedApiToken) => void;
}> = ({ opened, onClose, onCreated }) => {
	const { i18n } = useLingui();
	const can = useCan();
	const queryClient = useQueryClient();
	const available = tokenPermissionIds.filter((id) => can(id));
	const form = useForm<CreateApiTokenInput>({
		mode: "controlled",
		initialValues: {
			name: "",
			scope: "personal",
			permissions: available.filter((id) => id.endsWith(".view")),
			expiresInDays: 90,
		},
		validate: schemaResolver(CreateApiTokenSchema(i18n), { sync: true }),
	});
	const create = useAppMutation({
		mutationFn: (values: CreateApiTokenInput) =>
			createApiTokenFn({ data: values }),
		form,
		onSuccess: async (result) => {
			form.reset();
			await queryClient.invalidateQueries({ queryKey: ["api-tokens"] });
			onCreated(result);
		},
	});
	const groups = [...new Set(available.map((id) => permissions[id].group))];
	const selected = new Set<Permission>(form.values.permissions);
	// Implied by another ticked permission: shown ticked and locked.
	const implied = new Set<Permission>(
		form.values.permissions.flatMap((id) => impliedBy(id)),
	);
	const setPermissions = (ids: Permission[]) =>
		form.setFieldValue(
			"permissions",
			withImplied(ids).filter((id) => available.includes(id)),
		);
	const presets = tokenPresets.map((preset) => {
		const ids = presetPermissions(preset).filter((id) =>
			available.includes(id),
		);
		return { preset, ids };
	});
	const activePreset = presets.find(
		({ ids }) =>
			ids.length === selected.size && ids.every((id) => selected.has(id)),
	)?.preset.id;

	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={i18n._("Create API token")}
			size="lg"
		>
			<form onSubmit={form.onSubmit((values) => create.mutate(values))}>
				<Stack>
					<TextInput
						label={i18n._("Name")}
						placeholder={i18n._("CI deploys")}
						data-autofocus
						{...form.getInputProps("name")}
					/>
					<Group grow align="flex-start">
						<div>
							<Text size="sm" fw={500} mb={4}>
								{i18n._("Scope")}
							</Text>
							<SegmentedControl
								fullWidth
								value={form.values.scope}
								onChange={(value) =>
									form.setFieldValue("scope", value as TokenScope)
								}
								data={[
									{ value: "personal", label: i18n._("Personal") },
									{
										value: "team",
										label: i18n._("Team"),
										disabled: !can("tokens.manage"),
									},
								]}
							/>
						</div>
						<Select
							label={i18n._("Expires after")}
							allowDeselect={false}
							data={API_TOKEN_EXPIRY_DAYS.map((days) => ({
								value: String(days),
								label: i18n._("{days, plural, one {# day} other {# days}}", {
									days,
								}),
							}))}
							value={String(form.values.expiresInDays)}
							onChange={(value) =>
								value && form.setFieldValue("expiresInDays", Number(value))
							}
						/>
					</Group>
					<div>
						<Text size="sm" fw={500} mb={4}>
							{i18n._("Start from a preset")}
						</Text>
						<SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
							{presets.map(({ preset, ids }) => (
								<Button
									key={preset.id}
									variant={activePreset === preset.id ? "light" : "default"}
									justify="flex-start"
									h="auto"
									py={6}
									disabled={ids.length === 0}
									onClick={() => setPermissions(ids)}
								>
									<Stack gap={0} align="flex-start">
										<Text size="sm" fw={500}>
											{i18n._(preset.label)}
										</Text>
										<Text
											size="xs"
											c="dimmed"
											ta="left"
											style={{ whiteSpace: "normal" }}
										>
											{i18n._(preset.description)}
										</Text>
									</Stack>
								</Button>
							))}
						</SimpleGrid>
					</div>
					<Text size="sm" fw={500}>
						{i18n._("Permissions")}
					</Text>
					<Text size="xs" c="dimmed">
						{i18n._(
							"Permissions another one needs are added automatically (for example, deploying needs viewing apps).",
						)}
					</Text>
					{form.errors.permissions && (
						<Text size="xs" c="red">
							{form.errors.permissions}
						</Text>
					)}
					<SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
						{groups.map((group) => (
							<Stack key={group} gap={4}>
								<Text size="xs" c="dimmed" tt="uppercase" fw={700}>
									{i18n._(permissionGroupLabels[group as PermissionGroup])}
								</Text>
								{available
									.filter((id) => permissions[id].group === group)
									.map((id) => (
										<Checkbox
											key={id}
											size="xs"
											label={i18n._(permissions[id].label)}
											checked={selected.has(id)}
											disabled={implied.has(id)}
											description={
												implied.has(id)
													? i18n._("Needed by another permission")
													: undefined
											}
											onChange={(event) =>
												setPermissions(
													event.currentTarget.checked
														? [...form.values.permissions, id]
														: form.values.permissions.filter(
																(item) => item !== id,
															),
												)
											}
										/>
									))}
							</Stack>
						))}
					</SimpleGrid>
					<Group justify="flex-end">
						<Button type="submit" loading={create.isPending}>
							{i18n._("Create token")}
						</Button>
					</Group>
				</Stack>
			</form>
		</Modal>
	);
};
