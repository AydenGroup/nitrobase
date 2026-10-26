import { randomBytes } from "node:crypto";
import {
	databaseVersionRef,
	engineVersion,
	parseDatabaseVersion,
} from "#/config/database-engines.ts";
import { getConfig } from "#/config/server.ts";
import { TEXT_LIMITS } from "#/config/text-limits.ts";
import {
	appInputs,
	containerName,
	readEnvValues,
} from "#/features/apps/apps.server.ts";
import type {
	AppSourceDriver,
	SourceApp,
} from "#/features/apps/sources.server.ts";
import { clip } from "#/libs/format.ts";
import {
	DATABASE_PORT_ID,
	DATABASE_SERVICE,
	databaseManifest,
	databaseRenderInput,
	serverEngine,
} from "#/server/services/databases/engines.ts";
import { runCapped } from "#/server/services/databases/exec.ts";
import { TemplateError } from "#/server/services/templates/naming.ts";
import { AppError, commandError } from "#/utils/error.ts";

/**
 * App source driver of databases (R3 M2). The engine and image tag are the
 * app's version (`<engine>@<tag>`), so restores, clones and moves carry
 * them; the compose file, variables, backup strategy and published port
 * come from the engine registry. After each deploy the console's
 * read-only login is (re)created.
 */

/** Values the manifest needs before the first deploy (overrides) or after. */
function valuesOf(app: SourceApp): Record<string, string> {
	const env = app.envEncrypted
		? readEnvValues({ envEncrypted: app.envEncrypted })
		: {};
	return {
		...env,
		...(app.inputs ? appInputs({ inputs: app.inputs }).overrides : {}),
	};
}

function engineOf(version: string | undefined) {
	const parsed = version ? parseDatabaseVersion(version) : null;
	if (!parsed) {
		throw new TemplateError("DATABASE_VERSION_INVALID", {
			version: version ?? "",
		});
	}
	return parsed;
}

export const databaseSourceDriver: AppSourceDriver = {
	kind: "database",
	createField: "database",
	// Engine and pinned image tag (the app's version); a clone passes the
	// backed-up version instead.
	async prepareCreate({ template, input }) {
		const ref = input.database
			? databaseVersionRef(input.database.engine, input.database.version)
			: (input.version ?? null);
		const parsed = ref ? parseDatabaseVersion(ref) : null;
		if (
			!ref ||
			!parsed ||
			(input.database && !engineVersion(parsed.engine, parsed.tag))
		) {
			throw new AppError("DATABASE_VERSION_INVALID", { version: ref ?? "" });
		}
		const user = input.inputs.DB_USER;
		if (user && serverEngine(parsed.engine).reservedUsers.includes(user)) {
			throw new AppError("DATABASE_USER_RESERVED", { name: user });
		}
		return {
			manifest: databaseManifest(template, {
				engine: parsed.engine,
				values: input.inputs,
			}),
			version: ref,
		};
	},
	async manifest(base, app) {
		const parsed = app.version ? parseDatabaseVersion(app.version) : null;
		if (!parsed) return base;
		return databaseManifest(base, {
			engine: parsed.engine,
			values: valuesOf(app),
		});
	},
	async renderInput(base, app, options) {
		const version = options.version ?? app.version ?? "";
		return databaseRenderInput(base, {
			version,
			exposed: DATABASE_PORT_ID in (app.inputs?.publishedPorts ?? {}),
			values: valuesOf(app),
		});
	},
	async afterDeploy({ executor, app, rendered, ctx }) {
		const { engine } = engineOf(rendered.version);
		const container = containerName(app.folder, DATABASE_SERVICE);
		const config = getConfig();
		const limits = {
			timeoutMs: config.DATABASE_ADMIN_TIMEOUT_MS,
			maxBytes: config.DATABASE_CONSOLE_MAX_OUTPUT_BYTES,
			maxErrorBytes: config.DATABASE_CONSOLE_MAX_ERROR_BYTES,
		};
		const nonce = randomBytes(16).toString("hex");
		const setup = serverEngine(engine).consoleLogin({
			container,
			values: rendered.values,
			nonce,
			limits,
		});
		if (!setup) return;
		ctx.event("database.console_login");
		const result = await runCapped(executor, setup.command, {
			input: setup.input,
			timeoutMs: limits.timeoutMs + config.DATABASE_EXEC_SLACK_MS,
			nonce,
			limits,
		});
		const failed =
			result.exitCode !== 0 || (setup.verify && !setup.verify(result.body));
		if (failed) {
			throw commandError(
				"DATABASE_CONSOLE_LOGIN_FAILED",
				clip((result.stderr || result.body).trim(), TEXT_LIMITS.errorDetail),
			);
		}
	},
};
