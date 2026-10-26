import type { I18n } from "@lingui/core";
import { codedTermLabel } from "#/config/coded-terms.ts";
import { APP_NAME } from "#/config/shared.ts";
import {
	type CodedParams,
	type ErrorInfo,
	formatCodedParams,
} from "#/libs/coded.ts";
import type { ErrorCode, ErrorParamsMap } from "#/libs/error-codes.ts";
import { errorCodes } from "#/libs/error-codes.ts";

/**
 * The source-language message of a code with its params filled in (plain
 * `{name}` placeholders; nested coded values by their own message). For
 * logs, tests and operators only: never shown to users as such.
 */
function sourceText(code: string, params: Record<string, unknown>): string {
	const template = (errorCodes as Record<string, { id?: string }>)[code]?.id;
	if (!template) return code;
	return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
		if (!(name in params)) return name === "appName" ? APP_NAME : whole;
		const value = params[name];
		if (typeof value !== "object" || value === null) return String(value);
		if ("$error" in value) {
			const nested = value.$error as {
				code?: string | null;
				params?: unknown;
				text?: string | null;
			};
			return nested.code
				? sourceText(
						nested.code,
						(nested.params ?? {}) as Record<string, unknown>,
					)
				: (nested.text ?? "");
		}
		if ("$list" in value && Array.isArray(value.$list)) {
			return value.$list.join(", ");
		}
		if ("$terms" in value) {
			const { set, ids } = (value.$terms ?? {}) as {
				set?: unknown;
				ids?: unknown;
			};
			if (!Array.isArray(ids)) return "";
			return ids
				.map((id) => codedTermLabel(String(set), String(id))?.id ?? String(id))
				.join(", ");
		}
		return JSON.stringify(Object.values(value)[0]);
	});
}

/** Constructor arguments of an AppError of code `C`. */
export type AppErrorArgs<C extends ErrorCode> =
	keyof ErrorParamsMap[C] extends never
		? [code: C, params?: ErrorParamsMap[C]]
		: [code: C, params: ErrorParamsMap[C]];

/**
 * Typed, translatable application error. Throw `new AppError(code, params)`
 * on the server; the constructor requires `params` only for codes whose
 * message has placeholders. errorMiddleware localizes it for the client.
 */
export class AppError<C extends ErrorCode = ErrorCode> extends Error {
	constructor(...args: AppErrorArgs<C>) {
		const [code, params = {} as ErrorParamsMap[C]] = args;
		// Source-language text for logs and tests; users get the message in
		// their language from the code (errorMiddleware, `errorText`).
		super(sourceText(code, params as Record<string, unknown>));
		this.code = code;
		this.params = params;
		this.name = "AppError";
	}
	code: C;
	params: ErrorParamsMap[C];

	toJSON() {
		return { code: this.code, params: this.params };
	}
}

export { internalError, toolOutputError } from "./plain-errors";

/**
 * A coded message that is not thrown (a warning, a stored reason): the
 * same codes and params as AppError, rendered with `errorText`.
 */
export function coded<C extends ErrorCode>(
	...args: AppErrorArgs<C>
): ErrorInfo {
	const [code, params] = args;
	return { code, params: (params ?? {}) as CodedParams, text: null };
}

/** Codes whose only param is raw tool output (`detail`, behind "Details"). */
export type DetailErrorCode = {
	[C in ErrorCode]: [keyof ErrorParamsMap[C]] extends ["detail"]
		? "detail" extends keyof ErrorParamsMap[C]
			? C
			: never
		: never;
}[ErrorCode];

/** A failed command: its coded step plus the command's own output. */
export function commandError(code: DetailErrorCode, detail: string): AppError {
	return new AppError(code, { detail } as never);
}

/** Localized message for an AppError; other errors keep their own message. */
export const getAppErrorMessage = (i18n: I18n, error: unknown): string => {
	if (error instanceof AppError && error.code in errorCodes) {
		const code = error.code as keyof typeof errorCodes;
		return i18n._({
			...errorCodes[code],
			values: formatCodedParams(i18n, error.params as Record<string, unknown>),
		});
	}
	return error instanceof Error
		? error.message
		: i18n._("Something went wrong");
};

/**
 * Whether a client-side error is the localized message of one of `codes`.
 * Server functions only deliver the (already localized) message, so it is
 * matched against each code's message in the same locale, with any
 * `{param}` accepting any text.
 */
export function isAppErrorMessage(
	i18n: I18n,
	error: unknown,
	codes: (keyof typeof errorCodes)[],
): boolean {
	if (!(error instanceof Error) && typeof error !== "string") return false;
	const message = typeof error === "string" ? error : error.message;
	const marker = "\u0000";
	const anyParam = new Proxy({}, { get: () => marker }) as Record<
		string,
		string
	>;
	return codes.some((code) => {
		const template = i18n._({ ...errorCodes[code], values: anyParam });
		const pattern = template
			.split(marker)
			.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
			.join("[\\s\\S]*");
		return new RegExp(`^${pattern}$`).test(message);
	});
}
