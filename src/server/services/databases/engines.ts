import { createHash } from "node:crypto";
import { stringify as stringifyYaml } from "yaml";
import {
	type DatabaseEngineId,
	databaseEngines,
	parseDatabaseVersion,
} from "#/config/database-engines.ts";
import type { TemplateManifest } from "#/features/templates/schema.ts";
import { TemplateError } from "#/server/services/templates/naming.ts";
import type { RenderInput } from "#/server/services/templates/render.ts";
import {
	DATABASE_DATA_VOLUME,
	DATABASE_SERVICE,
	type ServerEngine,
	text,
} from "./engines/common";
import { mongodbEngine } from "./engines/mongodb";
import { mysqlFamilyEngine } from "./engines/mysql";
import { postgresEngine } from "./engines/postgres";
import { valkeyEngine } from "./engines/valkey";

/**
 * Server side of the database engine registry: each engine's driver (one
 * module under `./engines/`: compose service, variables, backup strategy,
 * credentials, connection strings, size probe, console and users
 * management). The client registry (#/config/database-engines.ts) holds
 * names, versions and defaults under the same ids. Adding an engine = its
 * id and entry there, a driver module there and one line here.
 *
 * Every engine runs as one `db` service with a named `data` volume. It is
 * rendered by the same pipeline as every template, so the compose
 * transform, policy, resource limits, owner labels and backups apply. The
 * app's default network is `internal` (no route out, nothing in) unless
 * the owner publishes the port; linked apps reach the database through a
 * per-link network (#/server/services/databases/links.ts).
 *
 * Template texts (labels, descriptions) are English Lingui ids declared
 * with `msg`, so the extractor puts them in the catalog and the UI
 * translates them with `translateTemplateText` like template.toml texts.
 */

export {
	DATABASE_SERVICE,
	type DatabaseLogin,
} from "./engines/common";

/** Template port id of the optional published port. */
export const DATABASE_PORT_ID = "public";

export const serverEngines = {
	postgres: postgresEngine,
	mysql: mysqlFamilyEngine("mysql"),
	mariadb: mysqlFamilyEngine("mariadb"),
	valkey: valkeyEngine,
	mongodb: mongodbEngine,
} satisfies Record<DatabaseEngineId, ServerEngine>;

export function serverEngine(engine: DatabaseEngineId): ServerEngine {
	return serverEngines[engine];
}

/**
 * The compose file of a database (pure). `exposed`: the owner published
 * the port, so the default network can't be internal (Docker publishes
 * nothing from an internal network).
 */
export function databaseComposeYaml(input: {
	engine: DatabaseEngineId;
	tag: string;
	exposed: boolean;
}): string {
	const engine: ServerEngine = serverEngines[input.engine];
	const image = databaseEngines[input.engine].image;
	const volumes = [DATABASE_DATA_VOLUME, ...(engine.extraVolumes ?? [])];
	const compose: Record<string, unknown> = {
		services: { [DATABASE_SERVICE]: engine.service(image, input.tag) },
		volumes: Object.fromEntries(volumes.map((name) => [name, {}])),
	};
	if (!input.exposed) {
		compose.networks = { default: { internal: true } };
	}
	return stringifyYaml(compose, { lineWidth: 0 });
}

/**
 * The effective manifest of a database app: the `database` template's
 * with the engine's variables, backup (online dump, the data volume reset
 * before a restore), optional published port, default memory limit and a
 * container health check (no HTTP probe, no domain).
 */
export function databaseManifest(
	manifest: TemplateManifest,
	input: { engine: DatabaseEngineId; values: Record<string, string> },
): TemplateManifest {
	const engine: ServerEngine = serverEngines[input.engine];
	const definition = databaseEngines[input.engine];
	const variables = Object.fromEntries(
		Object.entries(engine.variables).map(([name, variable]) => [
			name,
			{
				secret: false,
				credential: false,
				editable: false,
				initial_only: false,
				type: "string" as const,
				rotatable: false,
				...variable,
			},
		]),
	) as TemplateManifest["variables"];
	return {
		...manifest,
		variables,
		domains: [],
		links: [],
		health: { timeout_seconds: 300 },
		requirements: {
			memory_mb: definition.memoryMb,
			disk_mb: manifest.requirements.disk_mb,
		},
		resources: { [DATABASE_SERVICE]: { memory_mb: definition.memoryMb } },
		ports: [
			{
				id: DATABASE_PORT_ID,
				service: DATABASE_SERVICE,
				port: definition.port,
				label: text.port,
				description: text.portHelp,
				default_host_port: definition.port,
			},
		],
		backup: {
			paths: [],
			volumes: [],
			stop: false,
			database: engine.backup(input.values),
			reset: [],
			reset_volumes: [DATABASE_DATA_VOLUME, ...(engine.extraVolumes ?? [])],
			hooks: [],
		},
	};
}

/**
 * Render input of a database app at `version` (`<engine>@<tag>`): the
 * generated compose file and manifest. The commit is a digest of the
 * version and compose (no upstream commit).
 */
export function databaseRenderInput(
	manifest: TemplateManifest,
	input: { version: string; exposed: boolean; values: Record<string, string> },
): Pick<
	RenderInput,
	"manifest" | "files" | "overlay" | "extraDefaults" | "version" | "commitSha"
> {
	const parsed = parseDatabaseVersion(input.version);
	if (!parsed) {
		throw new TemplateError("DATABASE_VERSION_INVALID", {
			version: input.version,
		});
	}
	const yaml = databaseComposeYaml({
		engine: parsed.engine,
		tag: parsed.tag,
		exposed: input.exposed,
	});
	return {
		manifest: databaseManifest(manifest, {
			engine: parsed.engine,
			values: input.values,
		}),
		files: [
			{
				path: manifest.source.compose,
				content: Buffer.from(yaml),
				executable: false,
			},
		],
		overlay: null,
		extraDefaults: {},
		version: input.version,
		commitSha: createHash("sha1")
			.update(`${input.version}\0${yaml}`)
			.digest("hex"),
	};
}
