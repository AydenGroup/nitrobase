import { useLingui } from "@lingui/react";
import {
	type MutationFunction,
	type UseMutationOptions,
	useMutation,
} from "@tanstack/react-query";
import { useState } from "react";
import { APP_NAME } from "#/config/shared.ts";
import { issuesToFormErrors, isZodError } from "#/utils/validate.ts";
import { notifications } from "./Notifications";

/**
 * `useMutation` with the app's feedback conventions, so pages don't repeat
 * them:
 * - `success`: toast shown after a successful save/deploy action;
 * - `field`: the input the request is about. A refusal is then shown inline
 *   under that field (`fieldError`) instead of a transient toast, and stays
 *   until the field changes (`clearFieldError`) or the next attempt;
 * - `form`: a Mantine form receiving server-side schema (zod) errors on its
 *   own fields instead of a toast;
 * - a request that never reached the server (offline, panel down) gets a
 *   readable message instead of the browser's "Failed to fetch".
 */
export function useAppMutation<TData, TVariables = void>(
	options: Omit<UseMutationOptions<TData, Error, TVariables>, "mutationFn"> & {
		mutationFn: MutationFunction<TData, TVariables>;
		success?: string | ((data: TData, variables: TVariables) => string | null);
		/** Field name, or per call (undefined: toast instead). */
		field?: string | ((variables: TVariables) => string | undefined);
		/** Form whose fields show server validation (zod) issues. */
		form?: { setErrors: (errors: Record<string, string>) => void };
	},
) {
	const { i18n } = useLingui();
	const { success, field, form, onSuccess, onError, ...rest } = options;
	const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
	const mutation = useMutation<TData, Error, TVariables>({
		...rest,
		onMutate: (variables, context) => {
			setFieldErrors({});
			return rest.onMutate?.(variables, context);
		},
		onSuccess: (data, variables, ...more) => {
			const message =
				typeof success === "function" ? success(data, variables) : success;
			if (message) notifications.success({ message });
			return onSuccess?.(data, variables, ...more);
		},
		onError: (error, variables, ...more) => {
			if (form && isZodError(error)) {
				form.setErrors(issuesToFormErrors(error));
				return onError?.(error, variables, ...more);
			}
			if (isNetworkError(error)) {
				notifications.error({
					message: i18n._(
						"Can't reach {appName}. Check your connection and try again.",
						{ appName: APP_NAME },
					),
				});
				return onError?.(error, variables, ...more);
			}
			const name = typeof field === "function" ? field(variables) : field;
			// A raw validation issue list is never shown as-is.
			const message = isZodError(error)
				? i18n._("The request was not valid. Reload the page and try again.")
				: error.message;
			if (name) setFieldErrors({ [name]: message });
			else notifications.error({ message });
			return onError?.(error, variables, ...more);
		},
	});
	return {
		...mutation,
		/** Inline error for `name` (the mutation's `field`), if refused. */
		fieldError: (name = typeof field === "string" ? field : "") =>
			fieldErrors[name],
		clearFieldError: () => setFieldErrors({}),
	};
}

/** fetch() failures (no HTTP response at all) across browsers. */
function isNetworkError(error: Error): boolean {
	return /^(failed to fetch|load failed|network ?error|network request failed)/i.test(
		error.message,
	);
}
