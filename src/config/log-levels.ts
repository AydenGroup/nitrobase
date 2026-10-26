import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import {
	CircleCheck,
	CircleX,
	Info,
	type LucideIcon,
	TriangleAlert,
} from "lucide-react";
import type { LogLevel } from "#/libs/job-log.ts";
import type { StatusTone } from "#/theme/tokens.ts";

export interface LogLevelMeta {
	/** Badge text. */
	label: MessageDescriptor;
	/** Level filter option. */
	filterLabel: MessageDescriptor;
	tone: StatusTone;
	icon: LucideIcon;
	/** Tint the row (background and text) so it stands out. */
	emphasis: boolean;
}

/**
 * Log levels as the log viewer shows them: badge label, tone (color from
 * `toneColors`), icon and filter option. Key order is the filter order.
 */
export const logLevels = {
	error: {
		label: msg({ id: "Error" }),
		filterLabel: msg({ id: "Errors" }),
		tone: "danger",
		icon: CircleX,
		emphasis: true,
	},
	warning: {
		label: msg({ id: "Warning" }),
		filterLabel: msg({ id: "Warnings" }),
		tone: "warning",
		icon: TriangleAlert,
		emphasis: true,
	},
	success: {
		label: msg({ id: "Success" }),
		filterLabel: msg({ id: "Success" }),
		tone: "success",
		icon: CircleCheck,
		emphasis: false,
	},
	info: {
		label: msg({ id: "Info" }),
		filterLabel: msg({ id: "Info" }),
		tone: "neutral",
		icon: Info,
		emphasis: false,
	},
} satisfies Record<LogLevel, LogLevelMeta>;

export const LOG_LEVEL_IDS = Object.keys(logLevels) as LogLevel[];

/** Log viewer layout (px). Rows are virtualized, so their height is fixed. */
export const LOG_VIEWER = {
	/** Row height; fits an `xs` badge with breathing room. */
	rowHeight: 22,
	/** Rows rendered above and below the viewport. */
	overscan: 30,
	/** Level badge width, so messages line up whatever the label. */
	badgeWidth: 84,
	/** Badge icon size. */
	badgeIconSize: 10,
	/** Default viewport height. */
	height: 480,
	/** How long the copy button shows "Copied" (ms). */
	copiedMs: 1500,
	/** Max height of an auto-sized (short output) viewer. */
	compactMaxHeight: 260,
} as const;
