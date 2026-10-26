import { useLingui } from "@lingui/react";
import {
	NumberInput,
	Select,
	Switch,
	Textarea,
	TextInput,
} from "@mantine/core";
import { useCallback, useState } from "react";
import type { z } from "zod";
import {
	formIssues,
	type SchemaField,
	validationMessage,
} from "#/config/schema-fields.ts";
import { SECRET_MASK } from "#/libs/env-file.ts";
import { SecretInput } from "./SecretInput";

/**
 * Client-side validation of a generated form before submit, so problems
 * show under their field (with its label) rather than as one server error.
 */
export function useSchemaFormIssues() {
	const [issues, setIssues] = useState<Record<string, string>>({});
	const clear = useCallback(
		(field?: string) =>
			setIssues((prev) =>
				field
					? Object.fromEntries(
							Object.entries(prev).filter(([name]) => name !== field),
						)
					: {},
			),
		[],
	);
	return {
		issues,
		/** True when valid; otherwise shows the issues and returns false. */
		check: (
			schema: z.ZodObject | undefined,
			values: Record<string, unknown>,
			editing: boolean,
		) => {
			const found = schema
				? formIssues(schema, values, { editing, secretMask: SECRET_MASK })
				: {};
			setIssues(found);
			return Object.keys(found).length === 0;
		},
		clear,
	};
}

/**
 * Inputs generated from a driver schema (`schemaFields`): text, secret,
 * number, enum and switch fields. Generated fields are not rendered.
 */
export const SchemaFormFields: React.FC<{
	fields: SchemaField[];
	values: Record<string, unknown>;
	onChange: (name: string, value: unknown) => void;
	/** Editing a stored config: empty secret inputs keep the stored value. */
	editing?: boolean;
	/** Field name -> validation message id (`formIssues`), shown under it. */
	errors?: Record<string, string | undefined>;
}> = ({ fields, values, onChange, editing = false, errors = {} }) => {
	const { i18n } = useLingui();
	return (
		<>
			{fields
				.filter((field) => !field.meta.generated)
				.map((field) => {
					const label = i18n._(field.meta.label);
					const help = field.meta.help ? i18n._(field.meta.help) : undefined;
					const value = values[field.name] ?? field.defaultValue;
					const error = errors[field.name]
						? validationMessage(i18n, errors[field.name] as string)
						: undefined;
					if (field.kind === "boolean") {
						return (
							<Switch
								key={field.name}
								label={label}
								description={help}
								error={error}
								checked={Boolean(value)}
								onChange={(event) =>
									onChange(field.name, event.currentTarget.checked)
								}
							/>
						);
					}
					if (field.kind === "enum") {
						return (
							<Select
								key={field.name}
								label={label}
								description={help}
								error={error}
								data={(field.meta.options ?? []).map((option) => ({
									value: option.value,
									label: i18n._(option.label),
								}))}
								value={value === undefined ? null : String(value)}
								onChange={(next) => onChange(field.name, next)}
								allowDeselect={false}
							/>
						);
					}
					if (field.kind === "number") {
						return (
							<NumberInput
								key={field.name}
								label={label}
								description={help}
								error={error}
								required={field.required}
								value={typeof value === "number" ? value : ""}
								onChange={(next) =>
									onChange(
										field.name,
										typeof next === "number" ? next : undefined,
									)
								}
							/>
						);
					}
					const text =
						field.meta.secret && value === SECRET_MASK
							? ""
							: String(value ?? "");
					const common = {
						label,
						description: help,
						error,
						required: field.required,
						placeholder:
							field.meta.secret && editing
								? i18n._("Leave unchanged")
								: field.meta.placeholder,
						value: text,
						autoComplete: "off",
					};
					if (field.meta.multiline) {
						return (
							<Textarea
								key={field.name}
								{...common}
								onChange={(event) =>
									onChange(field.name, event.currentTarget.value)
								}
							/>
						);
					}
					const Input = field.meta.secret ? SecretInput : TextInput;
					return (
						<Input
							key={field.name}
							{...common}
							onChange={(event) =>
								onChange(field.name, event.currentTarget.value)
							}
						/>
					);
				})}
		</>
	);
};
