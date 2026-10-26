import { type CodedParams, type ErrorInfo, errorText } from "#/libs/coded.ts";
import { type ErrorCode, errorCodes } from "#/libs/error-codes.ts";
import { AppError, toolOutputError } from "#/utils/error.ts";
import { serverI18n } from "./i18n.ts";

/**
 * Stored form of any error: AppErrors keep their code and params (rendered
 * in the reader's language where shown) plus their source-language text for
 * operators and API clients; other errors keep their raw message (tool
 * output, third-party text) without a code.
 */
export function errorInfoOf(error: unknown): ErrorInfo {
	if (error instanceof AppError) {
		const params = (error.params ?? {}) as CodedParams;
		const message = errorText(serverI18n(), { code: error.code, params });
		const detail = typeof params.detail === "string" ? params.detail : "";
		const embedsDetail =
			errorCodes[error.code as ErrorCode].id?.includes("{detail}");
		return {
			code: error.code,
			params,
			text:
				detail && !embedsDetail
					? `${message.replace(/\.$/, "")}: ${detail}`
					: message,
		};
	}
	if (error instanceof Error) {
		return { code: null, params: null, text: error.message };
	}
	return { code: null, params: null, text: String(error) };
}

/** `last_error*` columns of an error (null clears them). */
export function lastErrorColumns(error: unknown) {
	const info = error == null ? null : errorInfoOf(error);
	return {
		lastError: info?.text ?? null,
		lastErrorCode: info?.code ?? null,
		lastErrorParams: info?.params ?? null,
	};
}

/** `error*` columns of an error (null clears them). */
export function errorColumns(error: unknown) {
	const info = error == null ? null : errorInfoOf(error);
	return {
		error: info?.text ?? null,
		errorCode: info?.code ?? null,
		errorParams: info?.params ?? null,
	};
}

/**
 * An error with secrets removed from its raw text (plain errors) or its
 * tool output (`detail` of coded ones).
 */
export function redactError(
	error: unknown,
	redact: (text: string) => string,
): unknown {
	if (error instanceof AppError) {
		const params = error.params as Record<string, unknown>;
		if (typeof params.detail !== "string") return error;
		return new AppError(error.code, {
			...params,
			detail: redact(params.detail),
		} as never);
	}
	return toolOutputError(
		redact(error instanceof Error ? error.message : String(error)),
	);
}
