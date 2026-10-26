import type { ErrorInfo } from "#/libs/coded.ts";
import type { ErrorCode } from "#/libs/error-codes.ts";
import { AppError, type AppErrorArgs } from "#/utils/error.ts";

/**
 * Naming rules shared by the server and the client (forms, env editor):
 * pure, no data tables, so client chunks stay small.
 */

/** Template ids, app slugs and folder names: lowercase, digits, dashes. */
export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** Environment variable names usable in compose interpolation. */
export const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
/** RFC 1123 hostname (no wildcard). */
export const HOSTNAME_PATTERN =
	/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;

/** App folders look like `<templateId>-<8 hex>`; anything else is not ours. */
export const APP_FOLDER_PATTERN =
	/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?-[0-9a-f]{8}$/;

/**
 * A template, compose or input problem: a coded AppError (rendered in the
 * reader's language), kept as its own class so callers can tell input
 * problems from other failures.
 */
/** A stored coded problem thrown again (e.g. a value check's result). */
export function templateError(info: ErrorInfo): TemplateError {
	return new TemplateError(
		info.code as ErrorCode,
		(info.params ?? {}) as never,
	);
}

export class TemplateError<
	C extends ErrorCode = ErrorCode,
> extends AppError<C> {
	constructor(...args: AppErrorArgs<C>) {
		super(...args);
		this.name = "TemplateError";
	}
}

/** Names docker compose itself reads from the project `.env`. */
export const RESERVED_ENV_PATTERN = /^(COMPOSE_|DOCKER_|BUILDKIT_)/;

export function assertUserEnvName(name: string): string {
	if (!ENV_NAME_PATTERN.test(name)) {
		throw new TemplateError("VARIABLE_NAME_INVALID", { name });
	}
	if (RESERVED_ENV_PATTERN.test(name)) {
		throw new TemplateError("VARIABLE_NAME_RESERVED", { name });
	}
	return name;
}
