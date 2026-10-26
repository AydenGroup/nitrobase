import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import {
	Activity,
	DatabaseBackup,
	Globe,
	LayoutDashboard,
	type LucideIcon,
	Rocket,
	ScrollText,
	Settings2,
	SquareTerminal,
	Variable,
} from "lucide-react";
import { pluginTabsFor } from "#/plugins/registry.ts";
import type { Permission } from "./permissions";

export interface AppTab {
	id: string;
	label: MessageDescriptor;
	icon: LucideIcon;
	/** Shown only when the active team role grants it. */
	permission?: Permission;
	/** Added by the template's provider plugin (grouped under its name). */
	plugin?: boolean;
}

/** Built-in app page tabs (order = display order). */
const appTabs: AppTab[] = [
	{ id: "overview", label: msg({ id: "Overview" }), icon: LayoutDashboard },
	{ id: "deployments", label: msg({ id: "Deployments" }), icon: Rocket },
	{ id: "logs", label: msg({ id: "Logs" }), icon: ScrollText },
	{ id: "environment", label: msg({ id: "Environment" }), icon: Variable },
	{ id: "domains", label: msg({ id: "Domains" }), icon: Globe },
	{
		id: "backups",
		label: msg({ id: "Backups" }),
		icon: DatabaseBackup,
		permission: "backup.view",
	},
	{
		id: "monitoring",
		label: msg({ id: "Monitoring" }),
		icon: Activity,
		permission: "monitoring.view",
	},
	{
		id: "terminal",
		label: msg({ id: "Terminal" }),
		icon: SquareTerminal,
		permission: "app.terminal",
	},
	{ id: "settings", label: msg({ id: "Settings" }), icon: Settings2 },
];

/** Built-in tabs plus the template's provider plugin tabs (before Settings). */
export function tabsForTemplate(templateId: string): AppTab[] {
	const plugins = pluginTabsFor(templateId).map(
		({ id, label, icon, permission }): AppTab => ({
			id,
			label,
			icon,
			permission,
			plugin: true,
		}),
	);
	const settingsIndex = appTabs.findIndex((tab) => tab.id === "settings");
	return [
		...appTabs.slice(0, settingsIndex),
		...plugins,
		...appTabs.slice(settingsIndex),
	];
}
