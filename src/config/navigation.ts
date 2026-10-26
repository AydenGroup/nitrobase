import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import {
	Activity,
	AppWindow,
	Bell,
	Cloud,
	Database,
	DatabaseBackup,
	GitBranch,
	Globe,
	HardDrive,
	KeyRound,
	KeySquare,
	LayoutDashboard,
	type LucideIcon,
	Plus,
	ScrollText,
	Server,
	Settings2,
	ShieldCheck,
	Store,
	User,
	Users,
} from "lucide-react";
import type { Permission } from "./permissions";

export interface NavItem {
	label: MessageDescriptor;
	icon: LucideIcon;
	/** Path without locale prefix. */
	to: string;
	/** Only active on an exact match (default: prefix match). */
	exact?: boolean;
	/** Shown only when the active team role grants it. */
	permission?: Permission;
}

export interface NavSection {
	id: string;
	label: MessageDescriptor;
	items: NavItem[];
	/** Render the live app list under this section. */
	showApps?: boolean;
	/**
	 * Where the section shows: the sidebar (default) or the account menu
	 * (personal pages). The command palette lists both.
	 */
	placement?: "sidebar" | "account";
}

/** Sidebar registry (also feeds the command palette). */
export const navSections: NavSection[] = [
	{
		id: "overview",
		label: msg({ id: "Overview" }),
		items: [
			{
				label: msg({ id: "Dashboard" }),
				icon: LayoutDashboard,
				to: "/",
				exact: true,
			},
		],
	},
	{
		id: "apps",
		label: msg({ id: "Apps" }),
		showApps: true,
		items: [
			{
				label: msg({ id: "All apps" }),
				icon: AppWindow,
				to: "/apps",
				permission: "app.view",
				exact: true,
			},
			{
				label: msg({ id: "New app" }),
				icon: Plus,
				to: "/apps/new",
				permission: "app.deploy",
				exact: true,
			},
		],
	},
	{
		id: "infrastructure",
		label: msg({ id: "Infrastructure" }),
		items: [
			{
				label: msg({ id: "Servers" }),
				icon: Server,
				to: "/servers",
				permission: "server.view",
			},
			{
				label: msg({ id: "SSH Keys" }),
				icon: KeyRound,
				to: "/ssh-keys",
				permission: "ssh_key.view",
			},
			{
				label: msg({ id: "Domains" }),
				icon: Globe,
				to: "/domains",
				permission: "app.view",
			},
		],
	},
	{
		id: "data",
		label: msg({ id: "Data" }),
		items: [
			{
				label: msg({ id: "Databases" }),
				icon: Database,
				to: "/databases",
				permission: "database.view",
			},
			{
				label: msg({ id: "Backups" }),
				icon: DatabaseBackup,
				to: "/backups",
				permission: "backup.view",
			},
			{
				label: msg({ id: "Destinations" }),
				icon: HardDrive,
				to: "/destinations",
				permission: "backup.view",
			},
		],
	},
	{
		id: "activity",
		label: msg({ id: "Activity" }),
		items: [
			{
				label: msg({ id: "Jobs" }),
				icon: Activity,
				to: "/jobs",
				permission: "server.view",
			},
			{
				label: msg({ id: "Audit log" }),
				icon: ScrollText,
				to: "/audit",
				permission: "team.view",
			},
		],
	},
	{
		id: "marketplace",
		label: msg({ id: "Marketplace" }),
		items: [
			{
				label: msg({ id: "Marketplace" }),
				icon: Store,
				to: "/marketplace",
				permission: "app.view",
			},
		],
	},
	{
		id: "settings",
		label: msg({ id: "Settings" }),
		items: [
			{
				label: msg({ id: "Team" }),
				icon: Users,
				to: "/settings/team",
				permission: "team.view",
			},
			{
				label: msg({ id: "API tokens" }),
				icon: KeySquare,
				to: "/settings/tokens",
			},
			{
				label: msg({ id: "Notifications" }),
				icon: Bell,
				to: "/settings/notifications",
				permission: "notification.manage",
			},
			{
				label: msg({ id: "Cloud connections" }),
				icon: Cloud,
				to: "/settings/cloud-connections",
				permission: "cloud_connection.view",
			},
			{
				label: msg({ id: "GitHub token" }),
				icon: GitBranch,
				to: "/settings/github",
				permission: "instance.manage",
			},
			{
				label: msg({ id: "Instance" }),
				icon: Settings2,
				to: "/settings/instance",
				permission: "instance.manage",
			},
		],
	},
	{
		id: "account",
		label: msg({ id: "Account" }),
		placement: "account",
		items: [
			{ label: msg({ id: "Profile" }), icon: User, to: "/settings/profile" },
			{
				label: msg({ id: "Security" }),
				icon: ShieldCheck,
				to: "/settings/security",
			},
		],
	},
];

/** Personal pages, shown in the account menu. */
export const accountSection = navSections.find(
	(section) => section.placement === "account",
) as NavSection;

/** Whether `item` is active for the current (locale-stripped) path. */
export function isNavItemActive(item: NavItem, path: string): boolean {
	if (item.exact || item.to === "/") return path === item.to;
	return path === item.to || path.startsWith(`${item.to}/`);
}
