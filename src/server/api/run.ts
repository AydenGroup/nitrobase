import { type Actor, can } from "#/features/auth/access.ts";
import {
	localeFromAcceptLanguage,
	serverI18n,
} from "#/server/services/i18n.ts";
import { AppError, getAppErrorMessage } from "#/utils/error.ts";
import type { ApiRoute } from "./v1";

/**
 * Running a registry route (#/server/api/v1.ts) for an authenticated
 * actor, shared by REST and MCP so both gate, validate and fail the same
 * way: permission check, zod parse of params then body, handler call with
 * the gate recorded on the actor, AppError → coded, translated message.
 */

/** A refused or failed call: HTTP status and the JSON error body. */
export interface ApiFailure {
	ok: false;
	status: number;
	body: { error: string; message?: string } & Record<string, unknown>;
}

export type ApiOutcome = { ok: true; value: unknown } | ApiFailure;

const failure = (status: number, body: ApiFailure["body"]): ApiFailure => ({
	ok: false,
	status,
	body,
});

function errorStatus(code: string): number {
	if (code === "FORBIDDEN") return 403;
	if (code.endsWith("_NOT_FOUND") || code === "NOT_FOUND") return 404;
	if (code === "SERVER_BUSY") return 409;
	return 400;
}

export interface ApiCallInput {
	/** Path parameters (REST: strings from the URL). */
	params: unknown;
	/** The JSON body; read only once the permission and params passed. */
	body: () => Promise<{ ok: true; value: unknown } | ApiFailure>;
}

/** Permission and input checks; the parsed params and body, or why not. */
export async function prepareApiCall(
	actor: Actor,
	route: ApiRoute,
	input: ApiCallInput,
): Promise<{ ok: true; params: unknown; body: unknown } | ApiFailure> {
	if (!can(actor, route.permission)) {
		return failure(403, { error: "forbidden", permission: route.permission });
	}
	const params = route.params.safeParse(input.params);
	if (!params.success) {
		return failure(400, { error: "bad_request", issues: params.error.issues });
	}
	const raw = await input.body();
	if (!raw.ok) return raw;
	const body = route.body ? route.body.safeParse(raw.value) : null;
	if (body && !body.success) {
		return failure(400, { error: "bad_request", issues: body.error.issues });
	}
	return { ok: true, params: params.data, body: body?.data ?? {} };
}

/** An error thrown by a route as its coded failure (AppError) or a 500. */
export function apiErrorFailure(
	error: unknown,
	request: Request,
	label: string,
): ApiFailure {
	if (error instanceof AppError) {
		return failure(errorStatus(error.code), {
			error: error.code,
			message: getAppErrorMessage(
				serverI18n(
					localeFromAcceptLanguage(request.headers.get("accept-language")),
				),
				error,
			),
		});
	}
	console.error(`[api] ${label} failed`, error);
	return failure(500, { error: "internal_error" });
}

/** Check, validate and run `route` (not a `stream` one) for `actor`. */
export async function runApiRoute(
	actor: Actor,
	route: ApiRoute,
	input: ApiCallInput,
	request: Request,
	label: string = route.id,
): Promise<ApiOutcome> {
	const prepared = await prepareApiCall(actor, route, input);
	if (!prepared.ok) return prepared;
	try {
		const value = await route.handler({
			actor: { ...actor, gate: route.permission },
			params: prepared.params,
			body: prepared.body,
			request,
		});
		return { ok: true, value: value ?? null };
	} catch (error) {
		return apiErrorFailure(error, request, label);
	}
}
