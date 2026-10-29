import { useLingui } from "@lingui/react";
import {
	ActionIcon,
	Alert,
	Button,
	Checkbox,
	Group,
	NumberInput,
	Select,
	Stack,
	Text,
	Textarea,
} from "@mantine/core";
import { useMutation } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useEffect, useRef } from "react";
import { CodedList } from "#/components/ui/CodedList.tsx";
import { ErrorText } from "#/components/ui/ErrorText.tsx";
import { APP_NAME } from "#/config/shared.ts";
import { analyzeComposeFn } from "#/features/apps/apps.functions.ts";
import type {
	CustomComposeAnalysis,
	CustomComposeSpec,
} from "#/features/templates/schema.ts";
import { formatList } from "#/libs/intl.ts";

export type CustomComposeValue = CustomComposeSpec;

export const emptyCustomCompose = (): CustomComposeValue => ({
	compose: "",
	env: "",
	routes: [],
	backupVolumes: [],
	dataBinds: [],
});

/** Ready to deploy: checked, accepted by the policy, at least one route. */
export function customComposeReady(
	value: CustomComposeValue,
	analysis: CustomComposeAnalysis | null,
): boolean {
	return (
		!!analysis &&
		!analysis.error &&
		value.routes.length > 0 &&
		value.routes.every((route) =>
			analysis.services.some((service) => service.name === route.service),
		)
	);
}

/**
 * Paste a compose file and env, check it against Nitrobase's policy, then
 * pick the routed service/port(s) and the volumes to back up.
 */
export const CustomComposeForm: React.FC<{
	templateId: string;
	value: CustomComposeValue;
	onChange: (value: CustomComposeValue) => void;
	analysis: CustomComposeAnalysis | null;
	onAnalysis: (analysis: CustomComposeAnalysis | null) => void;
}> = ({ templateId, value, onChange, analysis, onAnalysis }) => {
	const { i18n } = useLingui();
	const check = useMutation({
		mutationFn: async () =>
			await analyzeComposeFn({
				data: { templateId, compose: value.compose, env: value.env },
			}),
		onSuccess: (result) => {
			onAnalysis(result);
			// Sensible defaults on the first check: the first service with a
			// port, and every named volume backed up.
			if (value.routes.length === 0) {
				const service =
					result.services.find((item) => item.ports.length > 0) ??
					result.services[0];
				onChange({
					...value,
					routes: service
						? [{ service: service.name, port: service.ports[0] ?? 80 }]
						: [],
					backupVolumes: result.volumes,
				});
			} else {
				onChange({
					...value,
					backupVolumes: value.backupVolumes.filter((volume) =>
						result.volumes.includes(volume),
					),
					dataBinds: value.dataBinds.filter((bind) =>
						result.fileBinds.includes(bind),
					),
				});
			}
		},
		onError: () => onAnalysis(null),
	});
	// Re-check a loaded spec once (edit dialog).
	const checkedOnce = useRef(false);
	useEffect(() => {
		if (!checkedOnce.current && value.compose && !analysis) {
			checkedOnce.current = true;
			check.mutate();
		}
	}, [value.compose, analysis, check]);

	const services = analysis?.services ?? [];
	const setRoute = (
		index: number,
		patch: Partial<CustomComposeValue["routes"][number]>,
	) =>
		onChange({
			...value,
			routes: value.routes.map((route, i) =>
				i === index ? { ...route, ...patch } : route,
			),
		});

	return (
		<Stack gap="md">
			<Textarea
				label={i18n._("docker-compose.yml")}
				description={i18n._(
					'Published ports are removed (traffic goes through Traefik). Privileged mode, the Docker socket, host paths and host networking are refused. Services without a restart policy get one so they come back after a reboot: give a one-off job (migration, init) restart: "no".',
				)}
				value={value.compose}
				onChange={(event) => {
					onAnalysis(null);
					onChange({ ...value, compose: event.currentTarget.value });
				}}
				autosize
				minRows={10}
				maxRows={28}
				spellCheck={false}
				styles={{
					input: { fontFamily: "var(--mantine-font-family-monospace)" },
				}}
			/>
			<Textarea
				label={i18n._("Environment (.env)")}
				description={i18n._(
					"KEY=value lines for the variables the compose file reads. Stored encrypted; edit them later in the Environment tab.",
				)}
				value={value.env}
				onChange={(event) => {
					onAnalysis(null);
					onChange({ ...value, env: event.currentTarget.value });
				}}
				autosize
				minRows={3}
				maxRows={12}
				spellCheck={false}
				styles={{
					input: { fontFamily: "var(--mantine-font-family-monospace)" },
				}}
			/>
			<Group>
				<Button
					variant="light"
					onClick={() => check.mutate()}
					loading={check.isPending}
					disabled={!value.compose.trim()}
				>
					{i18n._("Check compose")}
				</Button>
				{analysis && !analysis.error && (
					<Text size="sm" c="green">
						{i18n._("{count} services, accepted by the policy", {
							count: services.length,
						})}
					</Text>
				)}
			</Group>
			{check.error && <Alert color="red">{check.error.message}</Alert>}
			{analysis?.error && (
				<Alert color="red" title={i18n._("Refused by the compose policy")}>
					<ErrorText error={analysis.error} />
				</Alert>
			)}
			{analysis && analysis.missingEnv.length > 0 && (
				<Alert color="yellow" title={i18n._("Variables without a value")}>
					{i18n._("The compose file uses {names}, which the env doesn't set.", {
						names: formatList(i18n.locale, analysis.missingEnv, "unit"),
					})}
				</Alert>
			)}
			{analysis && analysis.warnings.length > 0 && (
				<Alert
					color="gray"
					title={i18n._("Changes {appName} makes", { appName: APP_NAME })}
				>
					<CodedList items={analysis.warnings} max={12} />
				</Alert>
			)}

			{analysis && !analysis.error && (
				<>
					<Stack gap="xs">
						<Text fw={600} size="sm">
							{i18n._("Routed service")}
						</Text>
						<Text size="xs" c="dimmed">
							{i18n._(
								"The first one gets the app's domain; others get <service>.<domain>.",
							)}
						</Text>
						{value.routes.map((route, index) => {
							const ports =
								services.find((service) => service.name === route.service)
									?.ports ?? [];
							return (
								// biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity of their own (service and port are edited in place; a key made of them remounted the port input on every digit typed)
								<Group key={index} align="flex-end" wrap="nowrap">
									<Select
										label={i18n._("Service")}
										data={services.map((service) => service.name)}
										value={route.service}
										onChange={(next) =>
											next &&
											setRoute(index, {
												service: next,
												port:
													services.find((service) => service.name === next)
														?.ports[0] ?? route.port,
											})
										}
										allowDeselect={false}
										style={{ flex: 1 }}
									/>
									<NumberInput
										label={i18n._("Container port")}
										description={
											ports.length
												? i18n._("Declared: {ports}", {
														ports: formatList(
															i18n.locale,
															ports.map(String),
															"unit",
														),
													})
												: undefined
										}
										min={1}
										max={65535}
										value={route.port}
										onChange={(next) =>
											typeof next === "number" &&
											setRoute(index, { port: next })
										}
										w={170}
									/>
									{index > 0 && (
										<ActionIcon
											variant="subtle"
											color="red"
											mb={4}
											aria-label={i18n._("Remove")}
											onClick={() =>
												onChange({
													...value,
													routes: value.routes.filter((_, i) => i !== index),
												})
											}
										>
											<Trash2 size={16} />
										</ActionIcon>
									)}
								</Group>
							);
						})}
						<Group>
							<Button
								size="xs"
								variant="subtle"
								leftSection={<Plus size={14} />}
								disabled={services.length === 0}
								onClick={() =>
									onChange({
										...value,
										routes: [
											...value.routes,
											{
												service: services[0].name,
												port: services[0].ports[0] ?? 80,
											},
										],
									})
								}
							>
								{i18n._("Add a route")}
							</Button>
						</Group>
					</Stack>
					<Checkbox.Group
						label={i18n._("Volumes to back up")}
						description={i18n._(
							"Named volumes are archived with the app stopped. Bind folders and databases need care: prefer named volumes.",
						)}
						value={value.backupVolumes}
						onChange={(next) => onChange({ ...value, backupVolumes: next })}
					>
						<Stack gap={4} mt="xs">
							{(analysis.volumes.length ? analysis.volumes : []).map(
								(volume) => (
									<Checkbox key={volume} value={volume} label={volume} />
								),
							)}
							{analysis.volumes.length === 0 && (
								<Text size="xs" c="dimmed">
									{i18n._("The compose file declares no named volumes.")}
								</Text>
							)}
						</Stack>
					</Checkbox.Group>
					{analysis.fileBinds.length > 0 && (
						<Checkbox.Group
							label={i18n._("Files the app creates itself")}
							description={i18n._(
								"These bind mounts are named like files. Put each file in the app folder on the server before deploying, or tick it if the app creates it at runtime: otherwise Docker mounts an empty folder there and the deploy fails.",
							)}
							value={value.dataBinds}
							onChange={(next) => onChange({ ...value, dataBinds: next })}
						>
							<Stack gap={4} mt="xs">
								{analysis.fileBinds.map((bind) => (
									<Checkbox key={bind} value={bind} label={bind} />
								))}
							</Stack>
						</Checkbox.Group>
					)}
				</>
			)}
		</Stack>
	);
};
