import { useLingui } from "@lingui/react";
import {
	ActionIcon,
	Badge,
	Grid,
	Group,
	Stack,
	Text,
	Textarea,
	TextInput,
	Tooltip,
} from "@mantine/core";
import {
	Lock,
	type LucideIcon,
	RefreshCw,
	RotateCcw,
	Trash2,
	Undo2,
} from "lucide-react";
import type { ReactNode } from "react";
import { CopyIconButton } from "#/components/ui/CopyIconButton";
import { SecretInput } from "#/components/ui/SecretInput.tsx";
import { type Permission, permissions } from "#/config/permissions.ts";
import { isMasked } from "#/features/apps/env-editor.ts";
import type { AppEnvVariable } from "#/features/apps/schema.ts";
import { translateTemplateText } from "#/libs/i18n.ts";
import { type StatusTone, toneColors } from "#/theme/tokens.ts";

/** A row's pending change, shown as a badge. */
export type EnvRowState = "unchanged" | "changed" | "added" | "reset";

const ACTION_ICON_SIZE = 16;

const RowAction: React.FC<{
	label: string;
	icon: LucideIcon;
	onClick: () => void;
	tone?: StatusTone;
	disabled?: boolean;
}> = ({ label, icon: Icon, onClick, tone = "neutral", disabled }) => (
	<Tooltip label={label} withArrow>
		<ActionIcon
			variant="subtle"
			color={toneColors[tone]}
			aria-label={label}
			onClick={onClick}
			disabled={disabled}
		>
			<Icon size={ACTION_ICON_SIZE} />
		</ActionIcon>
	</Tooltip>
);

const RowBadge: React.FC<{
	tone: StatusTone;
	children: ReactNode;
	tooltip?: string;
	icon?: LucideIcon;
	variant?: "light" | "outline" | "filled";
}> = ({ tone, children, tooltip, icon: Icon, variant = "light" }) => {
	const badge = (
		<Badge
			size="xs"
			variant={variant}
			color={toneColors[tone]}
			leftSection={Icon ? <Icon size={10} /> : undefined}
		>
			{children}
		</Badge>
	);
	return tooltip ? (
		<Tooltip label={tooltip} withArrow multiline maw={280}>
			{badge}
		</Tooltip>
	) : (
		badge
	);
};

/**
 * One variable of the structured env editor: name, template texts and
 * badges on the left, the value and its actions on the right (stacked on
 * phones).
 */
export const EnvVariableRow: React.FC<{
	name: string;
	/** Template metadata (none: a variable added in this draft). */
	variable?: AppEnvVariable;
	value: string;
	state: EnvRowState;
	/** Plain values are loaded (audited reveal). */
	revealed: boolean;
	canEdit: boolean;
	can: (permission: Permission) => boolean;
	onChange: (value: string) => void;
	onUndo: () => void;
	onReset: () => void;
	onRotate: () => void;
	onDelete: () => void;
}> = ({
	name,
	variable,
	value,
	state,
	revealed,
	canEdit,
	can,
	onChange,
	onUndo,
	onReset,
	onRotate,
	onDelete,
}) => {
	const { i18n } = useLingui();
	const template = variable?.template ?? false;
	const secret = variable?.secret ?? false;
	const missingPermission =
		variable?.permission && !can(variable.permission)
			? variable.permission
			: undefined;
	const locked = variable?.locked ?? false;
	// Read by the app on its first start only (template `initial_only`).
	const initialOnly = variable?.initialOnly;
	const readOnly =
		!canEdit || locked || !!missingPermission || state === "reset";
	const label = translateTemplateText(i18n, variable?.label);
	const description = translateTemplateText(i18n, variable?.description);
	const hidden = secret && isMasked(value);
	const inputProps = {
		"aria-label": i18n._("Value of {name}", { name }),
		readOnly,
		// Values are app settings, never the panel's sign-in.
		autoComplete: "off",
		size: "sm" as const,
		styles: { input: { fontFamily: "var(--mantine-font-family-monospace)" } },
	};

	let input: ReactNode;
	if (secret) {
		input = (
			<SecretInput
				{...inputProps}
				// A masked value is not sent back as typed: typing replaces it.
				value={hidden ? "" : value}
				placeholder={hidden ? i18n._("Hidden. Type to replace it.") : undefined}
				onChange={(event) => onChange(event.currentTarget.value)}
				visibilityToggleButtonProps={{
					"aria-label": i18n._("Show or hide the value"),
				}}
			/>
		);
	} else if (value.includes("\n")) {
		input = (
			<Textarea
				{...inputProps}
				value={value}
				autosize
				minRows={2}
				maxRows={8}
				onChange={(event) => onChange(event.currentTarget.value)}
			/>
		);
	} else {
		input = (
			<TextInput
				{...inputProps}
				value={value}
				onChange={(event) => onChange(event.currentTarget.value)}
			/>
		);
	}

	return (
		<Grid gap="xs" align="flex-start" py="2xs">
			<Grid.Col span={{ base: 12, md: 5 }}>
				<Stack gap={4} style={{ minWidth: 0 }}>
					<Group gap={6} wrap="wrap">
						<Text
							ff="monospace"
							size="sm"
							fw={600}
							style={{ wordBreak: "break-all" }}
						>
							{name}
						</Text>
						{state === "changed" && (
							<RowBadge tone="warning" variant="outline">
								{i18n._("Modified")}
							</RowBadge>
						)}
						{state === "added" && (
							<RowBadge tone="success" variant="outline">
								{i18n._("New")}
							</RowBadge>
						)}
						{state === "reset" && (
							<RowBadge tone="warning" variant="outline">
								{i18n._("Reset on save")}
							</RowBadge>
						)}
					</Group>
					{label && (
						<Text size="sm" fw={500}>
							{label}
						</Text>
					)}
					{description && (
						<Text size="xs" c="dimmed">
							{description}
						</Text>
					)}
					{initialOnly && (
						<Text
							size="xs"
							c={initialOnly === "applied" ? toneColors.warning : "dimmed"}
						>
							{initialOnly === "applied"
								? i18n._(
										"Only used on first start; change it in the app itself. The value shown is the initial one and may no longer be current.",
									)
								: initialOnly === "not_applied"
									? i18n._(
											"Only used on first start, and added after this app's first start: the app does not use it. Set it in the app itself.",
										)
									: i18n._(
											"Only used on first start: after the first deploy it can no longer be changed here, only in the app itself.",
										)}
						</Text>
					)}
					<Group gap={4} wrap="wrap">
						{!template && variable && (
							<RowBadge tone="neutral" variant="outline">
								{i18n._("Custom")}
							</RowBadge>
						)}
						{secret && <RowBadge tone="warning">{i18n._("Secret")}</RowBadge>}
						{variable?.generated && (
							<RowBadge
								tone="info"
								tooltip={i18n._("The template generates this value.")}
							>
								{i18n._("Generated")}
							</RowBadge>
						)}
						{variable?.rotatable && (
							<RowBadge tone="progress">{i18n._("Rotatable")}</RowBadge>
						)}
						{variable?.overridden && state !== "reset" && (
							<RowBadge
								tone="info"
								variant="outline"
								tooltip={i18n._("Set by you instead of the template's value.")}
							>
								{i18n._("Overridden")}
							</RowBadge>
						)}
						{initialOnly && (
							<RowBadge
								tone={
									initialOnly === "applied"
										? "neutral"
										: initialOnly === "not_applied"
											? "warning"
											: "info"
								}
								icon={initialOnly === "applied" ? Lock : undefined}
							>
								{initialOnly === "applied"
									? i18n._("Initial value")
									: initialOnly === "not_applied"
										? i18n._("Not applied")
										: i18n._("First start only")}
							</RowBadge>
						)}
						{locked && initialOnly !== "applied" && (
							<RowBadge
								tone="neutral"
								icon={Lock}
								tooltip={i18n._(
									"Managed by the template. Use Developer view to override it.",
								)}
							>
								{i18n._("Read-only")}
							</RowBadge>
						)}
						{missingPermission && (
							<RowBadge
								tone="danger"
								icon={Lock}
								tooltip={i18n._(permissions[missingPermission].label)}
							>
								{i18n._("Needs permission")}
							</RowBadge>
						)}
					</Group>
				</Stack>
			</Grid.Col>
			<Grid.Col span={{ base: 12, md: 7 }}>
				<Group gap={4} wrap="nowrap" align="flex-start">
					<div style={{ flex: 1, minWidth: 0 }}>{input}</div>
					{!secret || revealed ? (
						<CopyIconButton
							value={hidden ? "" : value}
							label={i18n._("Copy value of {name}", { name })}
						/>
					) : null}
					{canEdit && state !== "unchanged" && state !== "added" && (
						<RowAction
							label={i18n._("Undo change")}
							icon={Undo2}
							onClick={onUndo}
						/>
					)}
					{canEdit &&
						template &&
						variable?.overridden &&
						initialOnly !== "applied" &&
						state === "unchanged" &&
						!missingPermission && (
							<RowAction
								label={i18n._("Reset to the template value")}
								icon={RotateCcw}
								onClick={onReset}
							/>
						)}
					{canEdit && variable?.rotatable && !missingPermission && (
						<RowAction
							label={i18n._("Rotate {name}", { name })}
							icon={RefreshCw}
							tone="warning"
							onClick={onRotate}
							disabled={state !== "unchanged"}
						/>
					)}
					{canEdit && !template && (
						<RowAction
							label={i18n._("Delete {name}", { name })}
							icon={Trash2}
							tone="danger"
							onClick={onDelete}
						/>
					)}
				</Group>
			</Grid.Col>
		</Grid>
	);
};
