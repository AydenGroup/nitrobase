import type { I18n } from "@lingui/core";
import {
	Box,
	Button,
	Card,
	Group,
	Progress,
	Stack,
	Text,
	ThemeIcon,
} from "@mantine/core";
import { ChevronRight, type LucideIcon, Plus } from "lucide-react";
import type { StatusMeta } from "#/config/status.ts";
import { LocalizedLink } from "#/libs/i18n.ts";
import { type StatusTone, toneColors } from "#/theme/tokens.ts";

/** One "● 3 running" item under the value. */
export interface StatBreakdownItem {
	key: string;
	tone: StatusTone;
	label: string;
	busy?: boolean;
}

interface StatCardProps {
	label: string;
	icon: LucideIcon;
	/** List page the card opens. */
	to: string;
	search?: Record<string, string>;
	value: number;
	/** Small word after the value ("failed"). */
	caption?: string;
	/** Tone of the whole card: warning/danger tint the value and border. */
	tone?: StatusTone;
	breakdown?: StatBreakdownItem[];
	/** Healthy share (0-1) drawn as a thin bar. */
	ratio?: number;
	/** Shown instead when `value` is 0. */
	empty?: { label: string; action?: { label: string; to: string } };
}

/** Tones ordered from most to least urgent. */
const TONE_SEVERITY: StatusTone[] = [
	"danger",
	"warning",
	"progress",
	"info",
	"success",
	"neutral",
];

/** The most urgent tone of `items` (neutral when none). */
export function worstTone(items: { tone: StatusTone }[]): StatusTone {
	const tones = new Set(items.map((item) => item.tone));
	return TONE_SEVERITY.find((tone) => tones.has(tone)) ?? "neutral";
}

/** Non-zero counts of a status registry, in registry order. */
export function statusBreakdown<K extends string>(
	i18n: I18n,
	registry: Record<K, StatusMeta>,
	counts: Partial<Record<K, number>>,
): StatBreakdownItem[] {
	return (Object.keys(registry) as K[]).flatMap((key) => {
		const count = counts[key] ?? 0;
		if (count === 0) return [];
		const meta = registry[key];
		return [
			{
				key,
				tone: meta.tone,
				busy: meta.busy,
				label: i18n._("{count} {status}", {
					count,
					status: i18n._(meta.label),
				}),
			},
		];
	});
}

const ALERT_TONES = new Set<StatusTone>(["danger", "warning"]);

/**
 * Dashboard metric tile: icon + label, one large number, a status
 * breakdown and an optional health bar. The whole card links to its list;
 * an empty card offers its create action instead.
 */
export const StatCard: React.FC<StatCardProps> = ({
	label,
	icon: Icon,
	to,
	search,
	value,
	caption,
	tone = "neutral",
	breakdown = [],
	ratio,
	empty,
}) => {
	const isEmpty = value === 0 && !!empty;
	const alert = ALERT_TONES.has(tone);
	const color = toneColors[tone];
	const linked = !isEmpty;

	const body = (
		<Stack gap="sm" h="100%">
			<Group justify="space-between" wrap="nowrap">
				<Group gap="sm" wrap="nowrap">
					<ThemeIcon
						variant="light"
						color={alert ? color : "gray"}
						size="lg"
						radius="md"
					>
						<Icon size={18} strokeWidth={1.75} />
					</ThemeIcon>
					<Text size="sm" c="dimmed" fw={500}>
						{label}
					</Text>
				</Group>
				{linked && (
					<ChevronRight size={16} className="stat-card-chevron" aria-hidden />
				)}
			</Group>

			{isEmpty ? (
				<Stack gap={6} mt="auto" align="flex-start">
					<Text fz={30} fw={700} lh={1} c="dimmed">
						—
					</Text>
					<Text size="xs" c="dimmed">
						{empty.label}
					</Text>
					{empty.action && (
						<Button
							component={LocalizedLink}
							to={empty.action.to}
							size="compact-xs"
							variant="light"
							leftSection={<Plus size={12} />}
						>
							{empty.action.label}
						</Button>
					)}
				</Stack>
			) : (
				<Stack gap={8} mt="auto">
					<Group gap={6} align="baseline" wrap="nowrap">
						<Text
							fz={30}
							fw={700}
							lh={1}
							c={alert ? `${color}.6` : undefined}
							style={{ fontVariantNumeric: "tabular-nums" }}
						>
							{value}
						</Text>
						{caption && (
							<Text size="sm" fw={500} c={alert ? `${color}.6` : "dimmed"}>
								{caption}
							</Text>
						)}
					</Group>
					{breakdown.length > 0 && (
						<Group gap="sm" style={{ rowGap: 2 }}>
							{breakdown.map((item) => (
								<Group key={item.key} gap={6} wrap="nowrap">
									<Box
										component="span"
										className={item.busy ? "status-dot-busy" : undefined}
										w={7}
										h={7}
										bdrs="xl"
										bg={`${item.tone === "progress" ? toneColors.success : toneColors[item.tone]}.6`}
										style={{ flexShrink: 0 }}
									/>
									<Text size="xs" c="dimmed">
										{item.label}
									</Text>
								</Group>
							))}
						</Group>
					)}
					{ratio !== undefined && (
						<Progress
							value={Math.round(ratio * 100)}
							size={4}
							radius="xl"
							color={ratio >= 1 ? toneColors.success : color}
							aria-hidden
						/>
					)}
				</Stack>
			)}
		</Stack>
	);

	const style = alert
		? {
				borderColor: `color-mix(in srgb, var(--mantine-color-${color}-filled) 50%, var(--sb-border))`,
			}
		: undefined;
	return linked ? (
		<Card
			withBorder
			p="md"
			className="stat-card"
			component={LocalizedLink}
			to={to}
			search={search}
			style={style}
		>
			{body}
		</Card>
	) : (
		<Card withBorder p="md" style={style}>
			{body}
		</Card>
	);
};
