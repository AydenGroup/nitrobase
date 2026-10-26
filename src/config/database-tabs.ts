import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import {
	Activity,
	DatabaseBackup,
	LayoutDashboard,
	type LucideIcon,
	Rocket,
	ScrollText,
	Settings2,
	SquareTerminal,
	Users,
} from "lucide-react";
import type { Permission } from "./permissions";

export interface DatabaseTab {
	id: string;
	label: MessageDescriptor;
	icon: LucideIcon;
	/** Shown only when the active team role grants it. */
	permission?: Permission;
	/** Shown only for engines with users and databases management. */
	needsUsers?: boolean;
}

/** Database page tabs (order = display order). */
export const databaseTabs: DatabaseTab[] = [
	{ id: "overview", label: msg({ id: "Overview" }), icon: LayoutDashboard },
	{
		id: "console",
		label: msg({ id: "Console" }),
		icon: SquareTerminal,
		permission: "database.manage",
	},
	{
		id: "users",
		label: msg({ id: "Users & databases" }),
		icon: Users,
		permission: "database.manage",
		needsUsers: true,
	},
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
	{ id: "logs", label: msg({ id: "Logs" }), icon: ScrollText },
	{ id: "deployments", label: msg({ id: "Jobs" }), icon: Rocket },
	{ id: "settings", label: msg({ id: "Settings" }), icon: Settings2 },
];
