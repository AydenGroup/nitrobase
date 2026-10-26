import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import type { SqlRisk } from "#/features/supabase/sql-guard.ts";

/**
 * Why a statement in the Database Functions tab needs the user's
 * confirmation (`analyzeSqlRisk`): the tab's warning list and the server's
 * refusal (`SQL_RISK_NOT_ACKNOWLEDGED`, risk ids as coded terms) both
 * render these.
 */
export const sqlRiskLabels = {
	drop_schema: msg({ id: "Drops a schema and everything in it" }),
	drop_database: msg({ id: "Drops a database" }),
	roles: msg({ id: "Changes database roles or server settings" }),
	privileges: msg({
		id: "Changes role memberships, object ownership or default privileges",
	}),
	session_role: msg({ id: "Switches the role of the database session" }),
	program: msg({
		id: "Runs a program inside the db container (COPY … PROGRAM)",
	}),
	server_files: msg({
		id: "Reads or writes files on the database server (COPY to or from a file, lo_import, lo_export)",
	}),
	extensions: msg({ id: "Drops or changes a database extension" }),
	managed_schema: msg({
		id: "Changes an object in a schema managed by the template",
	}),
	managed_data: msg({
		id: "Changes or deletes rows in a schema managed by the template",
	}),
	search_path: msg({
		id: "Points the search path at a schema managed by the template",
	}),
} satisfies Record<SqlRisk, MessageDescriptor>;
