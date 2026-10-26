import { useLingui } from "@lingui/react";
import { Badge, Button, Group, Stack, Text, TextInput } from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { SecretInput } from "#/components/ui/SecretInput.tsx";
import { useAppMutation } from "#/components/ui/useAppMutation";
import { type SettingKey, settingsRegistry } from "#/config/settings.ts";
import { updateSettingFn } from "#/features/settings/settings.functions.ts";
import { settingsQueryOptions } from "#/features/settings/settings.query.ts";

/** Form field for one registry setting (secret values are write-only). */
export const SettingField: React.FC<{
	settingKey: SettingKey;
	placeholder?: string;
}> = ({ settingKey, placeholder }) => {
	const { i18n } = useLingui();
	const queryClient = useQueryClient();
	const definition = settingsRegistry[settingKey];
	const { data: settings = [] } = useQuery(settingsQueryOptions);
	const view = settings.find((item) => item.key === settingKey);
	const [value, setValue] = useState("");

	useEffect(() => {
		if (view && !view.secret) setValue(view.value ?? "");
	}, [view]);

	const save = useAppMutation({
		mutationFn: async (next: string | null) =>
			await updateSettingFn({ data: { key: settingKey, value: next } }),
		onSuccess: async () => {
			await queryClient.invalidateQueries({
				queryKey: settingsQueryOptions.queryKey,
			});
			if (definition.secret) setValue("");
		},
		success: (_, next) =>
			next === null ? i18n._("Setting cleared.") : i18n._("Setting saved."),
		field: "value",
	});

	const Input = definition.secret ? SecretInput : TextInput;
	return (
		<Stack gap="xs">
			<Input
				label={
					<Group gap="xs" component="span">
						{i18n._(definition.label)}
						{view?.isSet && (
							<Badge
								size="xs"
								variant="light"
								color={view.fromEnv ? "gray" : "green"}
							>
								{view.fromEnv ? i18n._("Set via environment") : i18n._("Set")}
							</Badge>
						)}
					</Group>
				}
				description={i18n._(definition.description)}
				placeholder={
					definition.secret && view?.isSet ? "••••••••" : placeholder
				}
				value={value}
				onChange={(event) => {
					save.clearFieldError();
					setValue(event.currentTarget.value);
				}}
				error={save.fieldError()}
				autoComplete="off"
			/>
			<Group gap="xs">
				<Button
					size="xs"
					loading={save.isPending}
					disabled={!value.trim()}
					onClick={() => save.mutate(value.trim())}
				>
					{i18n._("Save")}
				</Button>
				{view?.isSet && !view.fromEnv && (
					<Button
						size="xs"
						variant="subtle"
						color="red"
						onClick={() => save.mutate(null)}
					>
						{i18n._("Clear")}
					</Button>
				)}
			</Group>
			{definition.secret && (
				<Text size="xs" c="dimmed">
					{i18n._("Stored encrypted. The saved value is never shown again.")}
				</Text>
			)}
		</Stack>
	);
};
