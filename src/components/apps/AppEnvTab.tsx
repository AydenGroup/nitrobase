import { useLingui } from "@lingui/react";
import {
	Accordion,
	Alert,
	Badge,
	Button,
	Divider,
	Group,
	Paper,
	Stack,
	Switch,
	Text,
	Textarea,
	TextInput,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, Plus, RefreshCw, Save, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useCan } from "#/components/teams/useCan";
import { notifications } from "#/components/ui/Notifications";
import { useAppMutation } from "#/components/ui/useAppMutation";
import { appStatuses, isBusy } from "#/config/status.ts";
import {
	appActionFn,
	revealAppEnvFn,
	rotateVariableFn,
	updateAppEnvFn,
} from "#/features/apps/apps.functions.ts";
import { appEnvQueryOptions } from "#/features/apps/apps.query.ts";
import {
	applyRevealed,
	countEnvChanges,
	diffEnvDraft,
	draftFromText,
	draftToText,
	type EnvDraft,
	type EnvSection,
	envNameProblem,
	envSavePayload,
	envSections,
	matchesEnvQuery,
} from "#/features/apps/env-editor.ts";
import type { AppEnvVariable, AppOverview } from "#/features/apps/schema.ts";
import { errorText } from "#/libs/coded.ts";
import { parseEnvFile } from "#/libs/env-file.ts";
import { translateTemplateText } from "#/libs/i18n.ts";
import { toneColors } from "#/theme/tokens.ts";
import { AppJobDrawer } from "./AppJobDrawer";
import { type EnvRowState, EnvVariableRow } from "./EnvVariableRow";
import { RotateHookCheckbox } from "./RotateHookCheckbox";
import { useAppJob } from "./useAppJob";

/** Error of a client-side check (coded AppError) in the reader's language. */
function problemText(
	i18n: Parameters<typeof errorText>[0],
	error: unknown,
): string {
	if (error && typeof error === "object" && "code" in error) {
		const { code, params } = error as { code: string; params?: object };
		return errorText(i18n, { code, params: params as never });
	}
	return error instanceof Error ? error.message : String(error);
}

/**
 * Environment tab: a structured editor (sections by template group, then
 * custom variables) and a raw `.env` "Developer view", both editing one
 * draft that is saved in a single request. Secrets stay masked until an
 * audited reveal.
 */
export const AppEnvTab: React.FC<{ overview: AppOverview }> = ({
	overview,
}) => {
	const { i18n } = useLingui();
	const can = useCan();
	const canEdit = can("app.env.edit");
	const app = overview.app;
	const appId = app.id;
	const queryClient = useQueryClient();
	const { data } = useQuery(appEnvQueryOptions(appId));
	const jobs = useAppJob(appId);

	/**
	 * The env edits are based on, pinned at the first edit or reveal (a
	 * refetch then doesn't move it), with its version; a save based on an
	 * older version is refused by the server. After a reveal it holds the
	 * plain values.
	 */
	const [snapshot, setSnapshot] = useState<{
		base: EnvDraft;
		version: string;
		revealed: boolean;
	} | null>(null);
	/** Edited draft (null: follows the base). */
	const [edited, setEdited] = useState<EnvDraft | null>(null);
	const [resets, setResets] = useState<Set<string>>(() => new Set());
	const [developer, setDeveloper] = useState(false);
	const [devText, setDevText] = useState("");
	const [devError, setDevError] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const [newName, setNewName] = useState("");
	const [newValue, setNewValue] = useState("");
	const [newError, setNewError] = useState<string | null>(null);

	const loadedBase = useMemo(
		() => (data ? parseEnvFile(data.text) : {}),
		[data],
	);
	const base = snapshot?.base ?? loadedBase;
	const version = snapshot?.version ?? data?.version ?? "";
	const revealed = !!snapshot?.revealed;
	const draft = edited ?? base;
	const variables = data?.variables ?? [];
	const byName = useMemo(
		() => new Map(variables.map((variable) => [variable.name, variable])),
		[variables],
	);
	const templateNames = useMemo(
		() =>
			new Set(
				variables
					.filter((variable) => variable.template)
					.map((variable) => variable.name),
			),
		[variables],
	);
	const changes = diffEnvDraft(base, draft, resets);
	const changeCount = countEnvChanges(changes);

	/** Record an edit, pinning the base it applies to. */
	const change = (next: EnvDraft) => {
		if (!snapshot) setSnapshot({ base, version, revealed: false });
		setEdited(next);
	};

	const discard = () => {
		setSnapshot(null);
		setEdited(null);
		setResets(new Set());
		setDevError(null);
		save.reset();
		save.clearFieldError();
		setSaveProblem(null);
		if (developer) setDevText(draftToText(loadedBase));
	};

	/** Drop the edits and load the latest env (after a refused save). */
	const reload = () => {
		discard();
		queryClient.invalidateQueries({
			queryKey: appEnvQueryOptions(appId).queryKey,
		});
	};

	const setValue = (name: string, value: string) => {
		save.clearFieldError();
		change({ ...draft, [name]: value });
	};

	const undo = (name: string) => {
		setResets((prev) => {
			const next = new Set(prev);
			next.delete(name);
			return next;
		});
		if (name in base) change({ ...draft, [name]: base[name] });
	};

	const remove = (name: string) => {
		const { [name]: _removed, ...rest } = draft;
		change(rest);
	};

	/** Developer view text -> draft; false (and an error) when invalid. */
	const syncFromText = (): EnvDraft | null => {
		try {
			const next = draftFromText(devText, draft, templateNames);
			change(next);
			setDevError(null);
			return next;
		} catch (error) {
			setDevError(problemText(i18n, error));
			return null;
		}
	};

	const toggleDeveloper = (on: boolean) => {
		if (on) {
			setDevText(draftToText(draft));
			setDevError(null);
			setDeveloper(true);
		} else if (syncFromText()) {
			setDeveloper(false);
		}
	};

	const save = useAppMutation({
		mutationFn: async (payload: ReturnType<typeof envSavePayload>) =>
			await updateAppEnvFn({ data: { appId, ...payload, version } }),
		onSuccess: (view) => {
			queryClient.setQueryData(appEnvQueryOptions(appId).queryKey, view);
			queryClient.invalidateQueries({ queryKey: ["apps", appId] });
			setSnapshot(null);
			setEdited(null);
			setResets(new Set());
			if (developer) setDevText(draftToText(parseEnvFile(view.text)));
		},
		success: i18n._("Environment saved. Redeploy to apply."),
		field: "env",
	});

	const [saveProblem, setSaveProblem] = useState<string | null>(null);
	const submit = () => {
		const next = developer ? syncFromText() : draft;
		if (!next) return;
		try {
			// Only what changed is sent: unchanged (e.g. revealed) values never.
			const payload = envSavePayload(base, next, resets);
			setSaveProblem(null);
			save.mutate(payload);
		} catch (error) {
			setSaveProblem(problemText(i18n, error));
		}
	};

	const reveal = useMutation({
		mutationFn: async () => await revealAppEnvFn({ data: appId }),
		onSuccess: (plain) => {
			const result = applyRevealed(base, draft, parseEnvFile(plain));
			setSnapshot({ base: result.base, version, revealed: true });
			if (edited) setEdited(result.draft);
			if (developer)
				setDevText(draftToText(edited ? result.draft : result.base));
		},
		onError: (error: Error) => notifications.error({ message: error.message }),
	});

	const confirmReveal = () =>
		modals.openConfirmModal({
			title: i18n._("Reveal secrets"),
			children: (
				<Text size="sm">
					{i18n._(
						"All secret values will be shown in plain text. The reveal is recorded in the audit log.",
					)}
				</Text>
			),
			labels: { confirm: i18n._("Reveal"), cancel: i18n._("Cancel") },
			// Developer view edits are folded into the draft first (kept).
			onConfirm: () => {
				if (!developer || syncFromText()) reveal.mutate();
			},
		});

	const confirmReset = (name: string) => {
		const variable = byName.get(name);
		modals.openConfirmModal({
			title: i18n._("Reset {name}", { name }),
			centered: true,
			children: (
				<Stack gap="xs">
					<Text size="sm">
						{variable?.generated
							? i18n._(
									"{name} keeps its current value; the template manages it from now on. Nothing changes on the next deploy. Applied when you save.",
									{ name },
								)
							: i18n._(
									"Your value is removed and the template's value is used again on the next deploy. Applied when you save.",
								)}
					</Text>
					{variable?.rotatable && (
						<Text size="sm" c="dimmed">
							{i18n._("To generate a new value, use Rotate.")}
						</Text>
					)}
				</Stack>
			),
			labels: { confirm: i18n._("Reset"), cancel: i18n._("Cancel") },
			onConfirm: () => {
				setResets((prev) => new Set(prev).add(name));
				change(name in base ? { ...draft, [name]: base[name] } : draft);
			},
		});
	};

	const confirmRotate = (name: string) => {
		const hook = byName.get(name)?.rotateHook ?? null;
		let runRotateHook = hook?.default;
		modals.openConfirmModal({
			title: i18n._("Rotate {name}", { name }),
			centered: true,
			children: (
				<Stack gap="sm">
					<Text size="sm">
						{i18n._(
							"A new value is generated for {name} (and anything derived from it) and the app is redeployed. The old value stops working.",
							{ name },
						)}
					</Text>
					{hook && (
						<RotateHookCheckbox
							hook={hook}
							onChange={(checked) => {
								runRotateHook = checked;
							}}
						/>
					)}
				</Stack>
			),
			labels: { confirm: i18n._("Rotate"), cancel: i18n._("Cancel") },
			confirmProps: { color: "red" },
			onConfirm: () => {
				setSnapshot(null);
				jobs.startJob({
					title: i18n._("Rotate {name}", { name }),
					start: () =>
						rotateVariableFn({ data: { appId, name, runRotateHook } }),
				});
			},
		});
	};

	const addVariable = () => {
		const name = newName.trim();
		const problem = envNameProblem(name, draft);
		if (problem === "duplicate") {
			setNewError(i18n._("A variable with this name already exists."));
			return;
		}
		if (problem) {
			setNewError(errorText(i18n, problem));
			return;
		}
		change({ ...draft, [name]: newValue });
		setNewName("");
		setNewValue("");
		setNewError(null);
	};

	const rowState = (name: string): EnvRowState => {
		if (resets.has(name)) return "reset";
		if (!(name in base)) return "added";
		return base[name] !== draft[name] ? "changed" : "unchanged";
	};

	const matches = (name: string, variable?: AppEnvVariable) =>
		matchesEnvQuery(query, [
			name,
			translateTemplateText(i18n, variable?.label),
			translateTemplateText(i18n, variable?.description),
		]);

	const sectionTitle = (section: EnvSection) =>
		section.kind === "custom"
			? i18n._("Custom variables")
			: section.kind === "general"
				? i18n._("General")
				: (translateTemplateText(i18n, section.title) ?? "");

	const sections = envSections(variables, draft);
	const visibleSections = sections
		.map((section) => ({
			...section,
			names: section.names.filter((name) => matches(name, byName.get(name))),
		}))
		.filter((section) => section.kind === "custom" || section.names.length);
	const sectionIds = sections.map((section) => section.id);
	const [openSections, setOpenSections] = useState<string[] | null>(null);
	// While searching every section with a match is open.
	const opened = query.trim() ? sectionIds : (openSections ?? sectionIds);
	const busy = jobs.isStarting || isBusy(appStatuses, app.status);

	return (
		<Stack gap="md">
			{app.envPendingAt && (
				<Alert color={toneColors.warning} variant="light">
					{i18n._(
						"These values aren't live yet: the last deploy didn't finish. They become live when a deploy succeeds.",
					)}
				</Alert>
			)}
			{data?.needsRedeploy && (
				<Alert color={toneColors.warning} title={i18n._("Redeploy needed")}>
					<Group justify="space-between" gap="sm">
						<Text size="sm">
							{i18n._("Saved changes take effect after a redeploy.")}
						</Text>
						{can("app.deploy") && (
							<Button
								size="xs"
								variant="default"
								leftSection={<RefreshCw size={14} />}
								loading={jobs.isStarting}
								disabled={busy}
								onClick={() =>
									jobs.startJob({
										title: i18n._("Redeploy app"),
										start: () =>
											appActionFn({ data: { appId, action: "redeploy" } }),
									})
								}
							>
								{i18n._("Redeploy")}
							</Button>
						)}
					</Group>
				</Alert>
			)}

			<Group justify="space-between" gap="sm" wrap="wrap">
				<TextInput
					aria-label={i18n._("Search variables")}
					placeholder={i18n._("Search variables")}
					leftSection={<Search size={16} />}
					value={query}
					onChange={(event) => setQuery(event.currentTarget.value)}
					disabled={developer}
					style={{ flex: 1, minWidth: 200 }}
				/>
				<Group gap="sm">
					<Switch
						label={i18n._("Developer view")}
						checked={developer}
						onChange={(event) => toggleDeveloper(event.currentTarget.checked)}
					/>
					{can("app.env.reveal") && (
						<Button
							variant="default"
							leftSection={<Eye size={16} />}
							disabled={revealed}
							loading={reveal.isPending}
							onClick={confirmReveal}
						>
							{i18n._("Reveal secrets")}
						</Button>
					)}
				</Group>
			</Group>

			{(save.fieldError() || saveProblem) && (
				<Alert color={toneColors.danger} variant="light">
					<Group justify="space-between" gap="sm">
						<Text size="sm">{saveProblem ?? save.fieldError()}</Text>
						{save.fieldError() && (
							<Button size="xs" variant="default" onClick={reload}>
								{i18n._("Reload")}
							</Button>
						)}
					</Group>
				</Alert>
			)}

			{developer ? (
				<Stack gap="xs">
					<Text size="sm" c="dimmed">
						{i18n._(
							"Paste or edit KEY=value lines. Masked values (********) are kept. Template variables can be changed but not removed; removing a custom line deletes it.",
						)}
					</Text>
					<Textarea
						aria-label={i18n._("Environment variables")}
						readOnly={!canEdit}
						value={devText}
						onChange={(event) => {
							save.clearFieldError();
							setDevError(null);
							setDevText(event.currentTarget.value);
							// Mark dirty so the save bar shows while typing.
							if (!edited) change({ ...draft });
						}}
						error={devError}
						autosize
						minRows={12}
						maxRows={30}
						styles={{
							input: {
								fontFamily: "var(--mantine-font-family-monospace)",
								fontSize: "var(--mantine-font-size-xs)",
							},
						}}
						spellCheck={false}
					/>
				</Stack>
			) : (
				<Accordion
					multiple
					variant="separated"
					value={opened}
					onChange={setOpenSections}
					chevronPosition="left"
				>
					{visibleSections.map((section) => (
						<Accordion.Item key={section.id} value={section.id}>
							<Accordion.Control>
								<Group gap="xs">
									<Text fw={600}>{sectionTitle(section)}</Text>
									<Badge size="sm" variant="light" color={toneColors.neutral}>
										{section.names.length}
									</Badge>
								</Group>
							</Accordion.Control>
							<Accordion.Panel>
								<Stack gap={0}>
									{section.names.map((name, index) => (
										<div key={name}>
											{index > 0 && <Divider />}
											<EnvVariableRow
												name={name}
												variable={byName.get(name)}
												value={draft[name] ?? ""}
												state={rowState(name)}
												revealed={revealed}
												canEdit={canEdit}
												can={can}
												onChange={(value) => setValue(name, value)}
												onUndo={() => undo(name)}
												onReset={() => confirmReset(name)}
												onRotate={() => confirmRotate(name)}
												onDelete={() => remove(name)}
											/>
										</div>
									))}
									{section.kind === "custom" && section.names.length === 0 && (
										<Text size="sm" c="dimmed" py="xs">
											{query.trim()
												? i18n._("No custom variable matches the search.")
												: i18n._("No custom variables yet.")}
										</Text>
									)}
									{section.kind === "custom" && canEdit && (
										<>
											<Divider my="xs" />
											<Group gap="xs" align="flex-start" wrap="wrap">
												<TextInput
													aria-label={i18n._("New variable name")}
													placeholder="MY_VARIABLE"
													value={newName}
													onChange={(event) => {
														setNewError(null);
														setNewName(event.currentTarget.value.toUpperCase());
													}}
													onKeyDown={(event) => {
														if (event.key === "Enter") addVariable();
													}}
													error={newError}
													styles={{
														input: {
															fontFamily:
																"var(--mantine-font-family-monospace)",
														},
													}}
													style={{ flex: 1, minWidth: 160 }}
												/>
												<TextInput
													aria-label={i18n._("New variable value")}
													placeholder={i18n._("Value")}
													value={newValue}
													onChange={(event) =>
														setNewValue(event.currentTarget.value)
													}
													onKeyDown={(event) => {
														if (event.key === "Enter") addVariable();
													}}
													style={{ flex: 2, minWidth: 160 }}
												/>
												<Button
													variant="default"
													leftSection={<Plus size={16} />}
													disabled={!newName.trim()}
													onClick={addVariable}
												>
													{i18n._("Add variable")}
												</Button>
											</Group>
										</>
									)}
								</Stack>
							</Accordion.Panel>
						</Accordion.Item>
					))}
				</Accordion>
			)}

			{canEdit && (changeCount > 0 || (developer && edited)) && (
				<Paper
					withBorder
					shadow="md"
					p="sm"
					pos="sticky"
					bottom="var(--mantine-spacing-md)"
					style={{ zIndex: 2 }}
					role="region"
					aria-label={i18n._("Unsaved changes")}
				>
					<Group justify="space-between" gap="sm">
						<Stack gap={2}>
							<Text size="sm" fw={500}>
								{developer
									? i18n._("Unsaved changes in the Developer view")
									: i18n._(
											"{count, plural, one {# unsaved change} other {# unsaved changes}}",
											{ count: changeCount },
										)}
								{" · "}
								<Text span size="sm" c="dimmed">
									{i18n._("Redeploy to apply after saving.")}
								</Text>
							</Text>
							{/* The error box sits at the top of a long page: repeat it here, next to Save. */}
							{(saveProblem ?? save.fieldError()) && (
								<Text size="sm" c="red" role="alert">
									{saveProblem ?? save.fieldError()}
								</Text>
							)}
						</Stack>
						<Group gap="xs">
							<Button
								variant="default"
								leftSection={<X size={16} />}
								onClick={discard}
								disabled={save.isPending}
							>
								{i18n._("Discard")}
							</Button>
							<Button
								leftSection={<Save size={16} />}
								loading={save.isPending}
								onClick={submit}
							>
								{i18n._("Save")}
							</Button>
						</Group>
					</Group>
				</Paper>
			)}

			<AppJobDrawer
				job={jobs.job}
				appName={app.name}
				onClose={jobs.closeJob}
				onCompleted={() => {
					jobs.refresh();
					queryClient.invalidateQueries({
						queryKey: appEnvQueryOptions(appId).queryKey,
					});
				}}
			/>
		</Stack>
	);
};
