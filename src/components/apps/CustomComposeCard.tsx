import { useLingui } from "@lingui/react";
import {
	Alert,
	Button,
	Card,
	Code,
	Group,
	Modal,
	ScrollArea,
	Stack,
	Text,
	Title,
} from "@mantine/core";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { CodedList } from "#/components/ui/CodedList.tsx";
import { notifications } from "#/components/ui/Notifications";
import { useRevealConfirm } from "#/components/ui/SecretField";
import {
	previewCustomComposeFn,
	revealCustomComposeFn,
	updateCustomComposeFn,
} from "#/features/apps/apps.functions.ts";
import type { AppOverview, AppUpdatePreview } from "#/features/apps/schema.ts";
import type { CustomComposeAnalysis } from "#/features/templates/schema.ts";
import { formatList } from "#/libs/intl.ts";
import {
	CustomComposeForm,
	type CustomComposeValue,
	customComposeReady,
} from "./CustomComposeForm";
import type { useAppJob } from "./useAppJob";

/**
 * Custom compose apps: edit the stored compose/env/routes/backup volumes,
 * preview the diff against what is deployed, save (applied on the next
 * deploy) or save and redeploy.
 */
export const CustomComposeCard: React.FC<{
	overview: AppOverview;
	jobs: ReturnType<typeof useAppJob>;
}> = ({ overview, jobs }) => {
	const { i18n } = useLingui();
	const { app } = overview;
	const confirmReveal = useRevealConfirm();
	const [value, setValue] = useState<CustomComposeValue | null>(null);
	const [analysis, setAnalysis] = useState<CustomComposeAnalysis | null>(null);
	const [preview, setPreview] = useState<AppUpdatePreview | null>(null);

	const close = () => {
		setValue(null);
		setAnalysis(null);
		setPreview(null);
	};
	const previewChanges = useMutation({
		mutationFn: async (spec: CustomComposeValue) =>
			await previewCustomComposeFn({ data: { appId: app.id, spec } }),
		onSuccess: setPreview,
		onError: (error: Error) => notifications.error({ message: error.message }),
	});
	const save = useMutation({
		mutationFn: async (input: {
			spec: CustomComposeValue;
			redeploy: boolean;
		}) =>
			await updateCustomComposeFn({
				data: { appId: app.id, spec: input.spec, redeploy: input.redeploy },
			}),
		onSuccess: async ({ deploymentId }) => {
			close();
			await jobs.refresh();
			if (deploymentId) jobs.openJob(deploymentId, i18n._("Redeploy"));
			else
				notifications.success({
					message: i18n._("Compose saved: redeploy to apply it"),
				});
		},
		onError: (error: Error) => notifications.error({ message: error.message }),
	});

	const ready = !!value && customComposeReady(value, analysis);

	return (
		<Card withBorder p="md">
			<Title order={5} mb="xs">
				{i18n._("Compose file")}
			</Title>
			<Text size="sm" c="dimmed" mb="sm">
				{i18n._(
					"Your docker-compose.yml and env, stored encrypted. Changes are checked by the same policy and shown as a diff before they apply.",
				)}
			</Text>
			<Button
				variant="light"
				onClick={() =>
					confirmReveal(i18n._("The compose file and its env"), async () => {
						setValue(await revealCustomComposeFn({ data: app.id }));
					})
				}
			>
				{i18n._("Edit compose")}
			</Button>

			<Modal
				opened={value !== null}
				onClose={close}
				title={i18n._("Edit compose")}
				size="xl"
			>
				{value && (
					<Stack>
						<CustomComposeForm
							templateId={app.templateId}
							value={value}
							onChange={(next) => {
								setPreview(null);
								setValue(next);
							}}
							analysis={analysis}
							onAnalysis={setAnalysis}
						/>
						{preview && (
							<Stack gap="xs">
								<Text size="sm" fw={600}>
									{i18n._("Changes against the deployed app")}
								</Text>
								<Text size="sm" c="dimmed">
									{i18n._(
										"Added: {added} · Removed: {removed} · Changed: {changed}",
										{
											added: formatList(i18n.locale, preview.env.added, "unit"),
											removed: formatList(
												i18n.locale,
												preview.env.removed,
												"unit",
											),
											changed: formatList(
												i18n.locale,
												preview.env.changed,
												"unit",
											),
										},
									)}
								</Text>
								{preview.warnings.length > 0 && (
									<Alert color="yellow">
										<CodedList items={preview.warnings} />
									</Alert>
								)}
								{preview.composeChanged ? (
									<ScrollArea h={320}>
										<Code block>{preview.composeDiff}</Code>
									</ScrollArea>
								) : (
									<Text size="sm" c="dimmed">
										{i18n._("No changes to the compose file.")}
									</Text>
								)}
							</Stack>
						)}
						<Group justify="flex-end">
							<Button variant="default" onClick={close}>
								{i18n._("Cancel")}
							</Button>
							<Button
								variant="light"
								disabled={!ready}
								loading={previewChanges.isPending}
								onClick={() => previewChanges.mutate(value)}
							>
								{i18n._("Preview changes")}
							</Button>
							<Button
								variant="default"
								disabled={!ready || !preview}
								loading={save.isPending && !save.variables?.redeploy}
								onClick={() => save.mutate({ spec: value, redeploy: false })}
							>
								{i18n._("Save")}
							</Button>
							<Button
								disabled={!ready || !preview}
								loading={save.isPending && !!save.variables?.redeploy}
								onClick={() => save.mutate({ spec: value, redeploy: true })}
							>
								{i18n._("Save and redeploy")}
							</Button>
						</Group>
					</Stack>
				)}
			</Modal>
		</Card>
	);
};
