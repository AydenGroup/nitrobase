import type { I18n } from "@lingui/core";
import { type CodedTermSet, codedTermLabel } from "#/config/coded-terms.ts";
import { APP_NAME } from "#/config/shared.ts";
import { type ErrorCode, errorCodes } from "#/libs/error-codes.ts";
import {
	formatBytes,
	formatDate,
	formatDuration,
	formatList,
} from "#/libs/intl.ts";

/**
 * Text the server cannot write in the reader's language is sent as a code
 * plus params and rendered where it is shown (job titles, job log events,
 * stored errors, warnings, notifications). Params are plain values or
 * tagged values formatted for the reader's locale:
 * - `{ $bytes }` → `formatBytes`, `{ $ms }` → `formatDuration`,
 *   `{ $date }` → `formatDate`, `{ $list }` → `formatList`;
 * - `{ $error }` → a nested coded error (`errorText`);
 * - `{ $terms: { set, ids } }` → the labels of registry ids
 *   (`#/config/coded-terms.ts`) as a list; an unknown id shows as is.
 * Numbers stay numbers (ICU `plural` needs them). Everything is JSON, so it
 * is stored as is (jsonb) and travels through server functions and SSE.
 */
export type CodedValue =
	| string
	| number
	| boolean
	| null
	| { $bytes: number }
	| { $ms: number }
	| { $date: string }
	| { $list: string[] }
	| { $terms: { set: CodedTermSet; ids: string[] } }
	| { $error: ErrorInfo };

export type CodedParams = Record<string, CodedValue>;

/**
 * A stored or transported error: `code` (an `errorCodes` key) + `params`
 * render in the reader's language; `text` is the legacy or untranslated
 * text (source-language rendering for operators and API clients, or raw
 * tool output when there is no code). A `detail` param holds raw tool
 * output shown behind "Details".
 */
export interface ErrorInfo {
	code: string | null;
	params: CodedParams | null;
	text: string | null;
}

export const asBytes = (value: number): CodedValue => ({ $bytes: value });
export const asList = (items: readonly string[]): CodedValue => ({
	$list: [...items],
});
export const asTerms = (
	set: CodedTermSet,
	ids: readonly string[],
): CodedValue => ({ $terms: { set, ids: [...ids] } });

function tagged<K extends string>(
	value: unknown,
	key: K,
): value is Record<K, unknown> {
	return typeof value === "object" && value !== null && key in value;
}

/**
 * Params with `redact` applied to every text they carry: plain strings,
 * list items and nested errors (their text and params, `detail` included).
 */
export function redactCodedParams(
	params: CodedParams,
	redact: (text: string) => string,
): CodedParams {
	const one = (value: CodedValue): CodedValue => {
		if (typeof value === "string") return redact(value);
		if (tagged(value, "$list")) return { $list: value.$list.map(redact) };
		if (tagged(value, "$error")) {
			const error = value.$error;
			return {
				$error: {
					code: error.code,
					params: error.params && redactCodedParams(error.params, redact),
					text: error.text && redact(error.text),
				},
			};
		}
		return value;
	};
	return Object.fromEntries(
		Object.entries(params).map(([key, value]) => [key, one(value)]),
	);
}

/** One param formatted for `i18n.locale` (numbers kept for plurals). */
export function formatCodedValue(
	i18n: I18n,
	value: unknown,
): string | number | boolean {
	if (value === null || value === undefined) return "";
	if (typeof value !== "object") return value as string | number | boolean;
	if (tagged(value, "$bytes")) {
		return formatBytes(i18n.locale, Number(value.$bytes));
	}
	if (tagged(value, "$ms")) {
		return formatDuration(i18n.locale, Number(value.$ms));
	}
	if (tagged(value, "$date")) {
		return formatDate(i18n.locale, String(value.$date));
	}
	if (tagged(value, "$list") && Array.isArray(value.$list)) {
		return formatList(i18n.locale, value.$list.map(String));
	}
	if (tagged(value, "$terms")) {
		const { set, ids } = (value.$terms ?? {}) as {
			set?: unknown;
			ids?: unknown;
		};
		if (!Array.isArray(ids)) return "";
		return formatList(
			i18n.locale,
			ids.map((id) => {
				const label = codedTermLabel(String(set), String(id));
				return label ? i18n._(label) : String(id);
			}),
		);
	}
	if (tagged(value, "$error")) {
		return errorText(i18n, value.$error as ErrorInfo);
	}
	return "";
}

/**
 * All params formatted for `i18n.locale`, ready for `i18n._`. `{appName}`
 * (the brand, `APP_NAME`) is always available.
 */
export function formatCodedParams(
	i18n: I18n,
	params: Record<string, unknown> | null | undefined,
): Record<string, string | number | boolean> {
	return {
		appName: APP_NAME,
		...Object.fromEntries(
			Object.entries(params ?? {}).map(([key, value]) => [
				key,
				formatCodedValue(i18n, value),
			]),
		),
	};
}

function isErrorCode(code: unknown): code is ErrorCode {
	return typeof code === "string" && Object.hasOwn(errorCodes, code);
}

/**
 * An error in the reader's language: its code's message, else its text,
 * else a generic message.
 */
export function errorText(
	i18n: I18n,
	error: Partial<ErrorInfo> | null | undefined,
): string {
	if (error && isErrorCode(error.code)) {
		return i18n._({
			...errorCodes[error.code],
			values: formatCodedParams(i18n, error.params),
		});
	}
	return error?.text || i18n._("Something went wrong");
}

/** Raw tool output of an error (`detail` param), shown behind "Details". */
export function errorDetail(
	error: Partial<ErrorInfo> | null | undefined,
): string | null {
	const detail = error?.params?.detail;
	return isErrorCode(error?.code) && typeof detail === "string" && detail
		? detail
		: null;
}

/** ErrorInfo of a row's columns (`<x>`, `<x>Code`, `<x>Params`). */
export function errorInfo(
	text: string | null | undefined,
	code: string | null | undefined,
	params: unknown,
): ErrorInfo | null {
	if (!text && !code) return null;
	return {
		code: code ?? null,
		params: (params as CodedParams | null) ?? null,
		text: text ?? null,
	};
}
