import { useLingui } from "@lingui/react";
import {
	Alert,
	Button,
	Card,
	Group,
	NumberInput,
	Stack,
	Table,
	Text,
	Title,
} from "@mantine/core";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useAppMutation } from "#/components/ui/useAppMutation";
import { lowMemoryLimits } from "#/features/apps/resource-limits.ts";
import {
	previewAppResourcesFn,
	updateAppResourcesFn,
} from "#/features/apps/resources.functions.ts";
import type {
	AppOverview,
	AppResourcesInput,
	ResourcesPreview,
} from "#/features/apps/schema.ts";
import { formatBytes, formatNumber } from "#/libs/intl.ts";

type Draft = Record<string, { memoryMb: number | null; cpus: number | null }>;

const MIB = 1024 * 1024;

/**
 * App → Settings → Resource limits (M6): memory and CPU limit per
 * service. Template defaults are prefilled; an empty field removes the
 * limit (unless the server requires one). Applied by the next deploy.
 */
export const AppResourcesCard: React.FC<{ overview: AppOverview }> = ({
	overview,
}) => {
	const { i18n } = useLingui();
	const queryClient = useQueryClient();
	const { app } = overview;
	const initial = useMemo<Draft>(
		() =>
			Object.fromEntries(
				overview.resources.map((item) => [
					item.service,
					{ memoryMb: item.memoryMb, cpus: item.cpus },
				]),
			),
		[overview.resources],
	);
	const [draft, setDraft] = useState<Draft>(initial);
	const [preview, setPreview] = useState<ResourcesPreview | null>(null);
	useEffect(() => setDraft(initial), [initial]);

	const payload = (): AppResourcesInput => ({
		appId: app.id,
		resources: Object.fromEntries(
			Object.entries(draft).map(([service, limits]) => [
				service,
				{ memoryMb: limits.memoryMb, cpus: limits.cpus },
			]),
		),
	});
	const draftKey = JSON.stringify(draft);
	const initialKey = JSON.stringify(initial);
	const changed = draftKey !== initialKey;

	const check = useAppMutation({
		mutationFn: async () => await previewAppResourcesFn({ data: payload() }),
		onSuccess: setPreview,
		field: "resources",
	});
	const save = useAppMutation({
		mutationFn: async () => await updateAppResourcesFn({ data: payload() }),
		success: i18n._("Resource limits saved. Redeploy to apply them."),
		field: "resources",
		onSuccess: async () => {
			setPreview(null);
			await queryClient.invalidateQueries({ queryKey: ["apps", app.id] });
		},
	});
	// Re-check overcommit shortly after edits.
	const runCheck = check.mutate;
	useEffect(() => {
		if (draftKey === initialKey) {
			setPreview(null);
			return;
		}
		const timer = setTimeout(() => runCheck(), 600);
		return () => clearTimeout(timer);
	}, [draftKey, initialKey, runCheck]);

	if (overview.resources.length === 0) return null;
	const set = (
		service: string,
		key: "memoryMb" | "cpus",
		value: string | number,
	) => {
		check.clearFieldError();
		setDraft((prev) => ({
			...prev,
			[service]: {
				...prev[service],
				[key]: typeof value === "number" && value > 0 ? value : null,
			},
		}));
	};
	const usage = new Map(
		(overview.usage?.services ?? []).map((item) => [item.service, item]),
	);
	const over = preview?.overcommit;
	const lowLimits = lowMemoryLimits(draft, overview.usage?.services ?? []);

	return (
		<Card withBorder p="md">
			<Title order={5} mb={4}>
				{i18n._("Resource limits")}
			</Title>
			<Text size="sm" c="dimmed" mb="sm">
				{i18n._(
					"Caps per service so one app cannot starve the others on this server. Leave a field empty for no limit. Changes apply on the next redeploy.",
				)}
			</Text>
			<Table.ScrollContainer minWidth={480}>
				<Table verticalSpacing="xs">
					<Table.Thead>
						<Table.Tr>
							<Table.Th>{i18n._("Service")}</Table.Th>
							<Table.Th>{i18n._("Memory limit (MiB)")}</Table.Th>
							<Table.Th>{i18n._("CPU limit (cores)")}</Table.Th>
							<Table.Th>{i18n._("Now")}</Table.Th>
						</Table.Tr>
					</Table.Thead>
					<Table.Tbody>
						{overview.resources.map((item) => {
							const now = usage.get(item.service);
							return (
								<Table.Tr key={item.service}>
									<Table.Td>
										<Text size="sm" ff="monospace">
											{item.service}
										</Text>
										{item.templateMemoryMb || item.templateCpus ? (
											<Text size="xs" c="dimmed">
												{i18n._("Template default: {memory} · {cpus}", {
													memory: item.templateMemoryMb
														? formatBytes(
																i18n.locale,
																item.templateMemoryMb * MIB,
															)
														: "—",
													cpus: item.templateCpus
														? formatNumber(i18n.locale, item.templateCpus)
														: "—",
												})}
											</Text>
										) : null}
									</Table.Td>
									<Table.Td>
										<NumberInput
											size="xs"
											w={120}
											min={6}
											step={128}
											placeholder={i18n._("No limit")}
											aria-label={i18n._("Memory limit of {service}", {
												service: item.service,
											})}
											value={draft[item.service]?.memoryMb ?? ""}
											onChange={(value) => set(item.service, "memoryMb", value)}
										/>
									</Table.Td>
									<Table.Td>
										<NumberInput
											size="xs"
											w={110}
											min={0.01}
											step={0.25}
											decimalScale={2}
											placeholder={i18n._("No limit")}
											aria-label={i18n._("CPU limit of {service}", {
												service: item.service,
											})}
											value={draft[item.service]?.cpus ?? ""}
											onChange={(value) => set(item.service, "cpus", value)}
										/>
									</Table.Td>
									<Table.Td>
										<Text size="xs" c="dimmed">
											{now?.memUsed !== null && now?.memUsed !== undefined
												? formatBytes(i18n.locale, now.memUsed)
												: "—"}
										</Text>
									</Table.Td>
								</Table.Tr>
							);
						})}
					</Table.Tbody>
				</Table>
			</Table.ScrollContainer>
			<Stack gap="xs" mt="sm">
				{preview?.missingLimit && (
					<Alert color="red" icon={<AlertTriangle size={16} />}>
						{i18n._(
							"This server requires a memory limit on every service: set one for {service}.",
							{ service: preview.missingLimit },
						)}
					</Alert>
				)}
				{lowLimits.map((item) => (
					<Alert
						key={item.service}
						color="yellow"
						icon={<AlertTriangle size={16} />}
					>
						{i18n._(
							"{service} uses {used} now, more than the {limit} limit. After a redeploy it will be killed for lack of memory.",
							{
								service: item.service,
								used: formatBytes(i18n.locale, item.usedMb * MIB),
								limit: formatBytes(i18n.locale, item.limitMb * MIB),
							},
						)}
					</Alert>
				))}
				{over && (over.memory.over || over.cpus.over) && (
					<Alert color="yellow" icon={<AlertTriangle size={16} />}>
						{i18n._(
							"With these limits, the apps on this server may use up to {limit} of {total} RAM and {cpus} of {cores} CPUs. That is fine while they do not peak together; otherwise some get killed or throttled.",
							{
								limit: formatBytes(i18n.locale, over.memory.limitMb * MIB),
								total: formatBytes(
									i18n.locale,
									(over.memory.totalMb ?? 0) * MIB,
								),
								cpus: formatNumber(i18n.locale, over.cpus.limit),
								cores: formatNumber(i18n.locale, over.cpus.total ?? 0),
							},
						)}
					</Alert>
				)}
				{(save.fieldError() || check.fieldError()) && (
					<Text size="sm" c="red">
						{save.fieldError() ?? check.fieldError()}
					</Text>
				)}
				<Group justify="flex-end">
					<Button
						variant="default"
						disabled={!changed}
						onClick={() => {
							setDraft(initial);
							setPreview(null);
						}}
					>
						{i18n._("Reset")}
					</Button>
					<Button
						disabled={!changed || !!preview?.missingLimit}
						loading={save.isPending}
						onClick={() => save.mutate()}
					>
						{i18n._("Save limits")}
					</Button>
				</Group>
			</Stack>
		</Card>
	);
};
