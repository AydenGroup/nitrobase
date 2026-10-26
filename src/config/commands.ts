import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import {
	Database,
	KeyRound,
	type LucideIcon,
	Plus,
	Server,
} from "lucide-react";
import type { Permission } from "./permissions";

interface CommandContext {
	navigate: (
		to: string,
		search?: Record<string, unknown>,
	) => Promise<void> | void;
}

export interface CommandAction {
	id: string;
	label: MessageDescriptor;
	description?: MessageDescriptor;
	icon: LucideIcon;
	/** Offered only when the active team role grants it. */
	permission?: Permission;
	run: (ctx: CommandContext) => Promise<void> | void;
}

/**
 * Global command palette actions. Entity actions (per app/server) are added
 * by `entityCommands` in the palette from live queries.
 */
export const commandActions: CommandAction[] = [
	{
		id: "new-app",
		label: msg({ id: "New app" }),
		description: msg({ id: "Deploy an app from a template" }),
		icon: Plus,
		permission: "app.deploy",
		run: (ctx) => ctx.navigate("/apps/new"),
	},
	{
		id: "new-database",
		label: msg({ id: "New database" }),
		description: msg({
			id: "PostgreSQL, MySQL, MariaDB, Valkey or MongoDB",
		}),
		icon: Database,
		permission: "database.manage",
		run: (ctx) => ctx.navigate("/databases/new"),
	},
	{
		id: "add-server",
		label: msg({ id: "Add server" }),
		description: msg({ id: "Connect a VPS over SSH" }),
		icon: Server,
		permission: "server.manage",
		run: (ctx) => ctx.navigate("/servers", { add: true }),
	},
	{
		id: "add-ssh-key",
		label: msg({ id: "Add SSH key" }),
		icon: KeyRound,
		permission: "ssh_key.manage",
		run: (ctx) => ctx.navigate("/ssh-keys", { add: true }),
	},
];
