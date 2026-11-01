import { useLingui } from "@lingui/react";
import { Badge, Box, Group, Text, Tooltip } from "@mantine/core";
import type { StatusMeta } from "#/config/status.ts";
import { toneColors } from "#/theme/tokens.ts";

/** Badge driven by a status registry entry. */
export const StatusBadge: React.FC<{
	meta: StatusMeta | undefined;
	fallback?: string;
	size?: "xs" | "sm" | "md";
	title?: string;
}> = ({ meta, fallback, size = "sm", title }) => {
	const { i18n } = useLingui();
	const color = meta ? toneColors[meta.tone] : "gray";
	return (
		<Badge
			color={color}
			variant="light"
			size={size}
			title={title}
			leftSection={meta?.busy ? <StatusDot meta={meta} size={6} /> : undefined}
		>
			{meta ? i18n._(meta.label) : fallback}
		</Badge>
	);
};

/** Small colored dot (pulses while busy) with an accessible label. */
export const StatusDot: React.FC<{
	meta: StatusMeta | undefined;
	size?: number;
	withLabel?: boolean;
}> = ({ meta, size = 8, withLabel = false }) => {
	const { i18n } = useLingui();
	const label = meta ? i18n._(meta.label) : "";
	const color = !meta
		? "gray"
		: meta.tone === "progress"
			? toneColors.success
			: toneColors[meta.tone];
	const dot = (
		<Box
			component="span"
			aria-label={label}
			role="img"
			className={meta?.busy ? "status-dot-busy" : undefined}
			w={size}
			h={size}
			bdrs="xl"
			bg={`${color}.6`}
			style={{ display: "inline-block", flexShrink: 0 }}
		/>
	);
	if (!withLabel) {
		return (
			<Tooltip label={label} disabled={!label} withArrow>
				{dot}
			</Tooltip>
		);
	}
	return (
		<Group gap={6} wrap="nowrap">
			{dot}
			<Text size="sm">{label}</Text>
		</Group>
	);
};
