import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import {
	Activity,
	AppWindow,
	LayoutDashboard,
	ListChecks,
	type LucideIcon,
	Settings2,
	SquareTerminal,
} from "lucide-react";
import type { Permission } from "./permissions";

/** Server page tabs registry (`permission`: shown only when granted). */
export const serverTabs: {
	id: string;
	label: MessageDescriptor;
	icon: LucideIcon;
	permission?: Permission;
}[] = [
	{ id: "overview", label: msg({ id: "Overview" }), icon: LayoutDashboard },
	{
		id: "apps",
		label: msg({ id: "Apps" }),
		icon: AppWindow,
		permission: "app.view",
	},
	{ id: "jobs", label: msg({ id: "Jobs" }), icon: ListChecks },
	{
		id: "terminal",
		label: msg({ id: "Terminal" }),
		icon: SquareTerminal,
		permission: "server.terminal",
	},
	{
		id: "monitoring",
		label: msg({ id: "Monitoring" }),
		icon: Activity,
		permission: "monitoring.view",
	},
	{ id: "settings", label: msg({ id: "Settings" }), icon: Settings2 },
];
