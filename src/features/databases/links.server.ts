import { and, eq, inArray, or } from "drizzle-orm";
import {
	databaseEngines,
	parseDatabaseVersion,
} from "#/config/database-engines.ts";
import { db } from "#/db/index.ts";
import { apps } from "#/db/schema/apps.ts";
import { databaseLinks } from "#/db/schema/databases.ts";
import {
	appOverrides,
	containerName,
	readEnvValues,
} from "#/features/apps/apps.server.ts";
import type { AppRow } from "#/features/apps/schema.ts";
import type { JobLogger } from "#/features/deployments/deployments.server.ts";
import {
	DATABASE_SERVICE,
	serverEngine,
} from "#/server/services/databases/engines.ts";
import {
	disconnectNetworkCommand,
	ensureLinkNetworksCommand,
	linkNetwork,
	linkNetworkName,
	pruneLinkNetworksCommand,
	removeLinkNetworkCommand,
	renderLinkEnv,
} from "#/server/services/databases/links.ts";
import type { Executor } from "#/server/services/executor.ts";
import type { LinkNetwork } from "#/server/services/templates/compose-policy.ts";
import { TemplateError } from "#/server/services/templates/naming.ts";
import { decrypt } from "#/utils/crypto.ts";
import { commandError } from "#/utils/error.ts";

/**
 * Database links in the deploy pipeline: what an app's render gets from
 * its links (both sides), and the networks a deploy must create first.
 * The link management itself (create/remove jobs) is in databases.server.
 */

export type LinkRow = typeof databaseLinks.$inferSelect;

/** Login a link's URL uses: the database's main one, or its own user. */
function linkLogin(
	link: LinkRow,
	database: Pick<AppRow, "version" | "envEncrypted" | "inputs">,
) {
	const parsed = parseDatabaseVersion(database.version);
	if (!parsed) throw new TemplateError("DATABASE_NO_ENGINE");
	const values = {
		...readEnvValues(database),
		...appOverrides(database),
	};
	const main = serverEngine(parsed.engine).login(values);
	return {
		engine: parsed.engine,
		login: {
			user: link.username ?? main.user,
			password: link.passwordEncrypted
				? decrypt(link.passwordEncrypted)
				: main.password,
			database: link.database ?? main.database,
		},
	};
}

/** Internal endpoint of a database: its container on the link network. */
export function internalEndpoint(database: Pick<AppRow, "folder" | "version">) {
	const parsed = parseDatabaseVersion(database.version);
	if (!parsed) throw new TemplateError("DATABASE_NO_ENGINE");
	return {
		host: containerName(database.folder, DATABASE_SERVICE),
		port: databaseEngines[parsed.engine].port,
	};
}

/** Env a linked app gets from one link (needs the database deployed). */
export function linkEnvValues(
	link: LinkRow,
	database: Pick<AppRow, "version" | "envEncrypted" | "inputs" | "folder">,
): Record<string, string> {
	const { engine, login } = linkLogin(link, database);
	return renderLinkEnv(engine, internalEndpoint(database), login, link.env);
}

export interface AppLinkRender {
	linkNetworks: LinkNetwork[];
	linkEnv: Record<string, string>;
	/** Networks to create before `up`. */
	networks: { name: string; linkId: string }[];
}

/**
 * What an app's render gets from its links: a database joins the network
 * of every link to it (its `db` service only); a linked app joins its
 * links' networks (all services) and gets their env.
 */
export async function appLinkRender(
	app: Pick<AppRow, "id">,
): Promise<AppLinkRender> {
	const links = await db
		.select()
		.from(databaseLinks)
		.where(
			or(
				eq(databaseLinks.databaseAppId, app.id),
				eq(databaseLinks.appId, app.id),
			),
		);
	const out: AppLinkRender = { linkNetworks: [], linkEnv: {}, networks: [] };
	if (links.length === 0) return out;
	const databaseIds = [
		...new Set(
			links
				.filter((link) => link.appId === app.id)
				.map((link) => link.databaseAppId),
		),
	];
	const databases = databaseIds.length
		? await db.select().from(apps).where(inArray(apps.id, databaseIds))
		: [];
	for (const link of links) {
		const asDatabase = link.databaseAppId === app.id;
		out.linkNetworks.push(
			linkNetwork(link.id, asDatabase ? [DATABASE_SERVICE] : "all"),
		);
		out.networks.push({ name: linkNetworkName(link.id), linkId: link.id });
		if (asDatabase) continue;
		const database = databases.find((row) => row.id === link.databaseAppId);
		// Not deployed yet (no credentials): the network alone.
		if (!database?.envEncrypted) continue;
		addLinkEnv(out.linkEnv, linkEnvValues(link, database));
	}
	return out;
}

/** Add one link's env to an app's: two links setting one name are refused. */
export function addLinkEnv(
	target: Record<string, string>,
	values: Record<string, string>,
): void {
	for (const [name, value] of Object.entries(values)) {
		if (name in target) {
			throw new TemplateError("DATABASE_LINK_ENV_TWO_LINKS", { name });
		}
		target[name] = value;
	}
}

/** Create the app's link networks before `up` (idempotent). */
export async function ensureLinkNetworks(
	executor: Executor,
	networks: { name: string; linkId: string }[],
	instanceId: string,
	ctx: JobLogger,
): Promise<void> {
	const command = ensureLinkNetworksCommand(networks, instanceId);
	if (!command) return;
	const result = await executor.exec(command);
	if (result.exitCode !== 0) {
		throw commandError(
			"DATABASE_LINK_NETWORK_FAILED",
			result.stderr || result.stdout,
		);
	}
	ctx.event("link.networks_ready", { count: networks.length });
}

/** Remove this panel's link networks no link uses (best effort). */
export async function pruneLinkNetworks(
	executor: Executor,
	serverId: string,
	instanceId: string,
): Promise<void> {
	const rows = await db
		.select({ id: databaseLinks.id })
		.from(databaseLinks)
		.innerJoin(apps, eq(apps.id, databaseLinks.databaseAppId))
		.where(eq(apps.serverId, serverId));
	await executor
		.exec(
			pruneLinkNetworksCommand(
				rows.map((row) => linkNetworkName(row.id)),
				instanceId,
			),
		)
		.catch(() => undefined);
}

/**
 * Before an app is deleted: cut its links (the database container leaves
 * each link network, which is then removed). The rows go with the app;
 * returns the databases whose files must be refreshed afterwards.
 */
export async function releaseAppLinks(
	executor: Executor,
	app: Pick<AppRow, "id">,
	ctx: JobLogger,
): Promise<string[]> {
	const links = await db
		.select()
		.from(databaseLinks)
		.where(eq(databaseLinks.appId, app.id));
	for (const link of links) {
		const network = linkNetworkName(link.id);
		const [database] = await db
			.select({ folder: apps.folder })
			.from(apps)
			.where(eq(apps.id, link.databaseAppId))
			.limit(1);
		if (database) {
			await executor.exec(
				disconnectNetworkCommand(
					network,
					containerName(database.folder, DATABASE_SERVICE),
				),
			);
		}
		await executor.exec(removeLinkNetworkCommand(network));
		ctx.event("link.removed", { network });
	}
	return [...new Set(links.map((link) => link.databaseAppId))];
}

/** Links of an app on either side (count). */
export async function countAppLinks(appId: string): Promise<number> {
	const rows = await db
		.select({ id: databaseLinks.id })
		.from(databaseLinks)
		.where(
			or(
				eq(databaseLinks.databaseAppId, appId),
				eq(databaseLinks.appId, appId),
			),
		);
	return rows.length;
}

/** Links to a database (count). */
export async function countDatabaseLinks(
	databaseAppId: string,
): Promise<number> {
	const rows = await db
		.select({ id: databaseLinks.id })
		.from(databaseLinks)
		.where(and(eq(databaseLinks.databaseAppId, databaseAppId)));
	return rows.length;
}
