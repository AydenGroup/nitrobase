import { useLingui } from "@lingui/react";
import {
	Button,
	Group,
	Modal,
	Select,
	Stack,
	Text,
	TextInput,
} from "@mantine/core";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
	SchemaFormFields,
	useSchemaFormIssues,
} from "#/components/ui/SchemaFormFields";
import { useAppMutation } from "#/components/ui/useAppMutation";
import {
	destinationDrivers,
	driverFields,
	getDestinationDriver,
} from "#/config/backup-drivers.ts";
import { secretFieldNames } from "#/config/schema-fields.ts";
import {
	createDestinationFn,
	updateDestinationFn,
} from "#/features/backups/backups.functions.ts";
import { destinationsQueryOptions } from "#/features/backups/backups.query.ts";
import type { DestinationDTO } from "#/features/backups/schema.ts";

/** Add/edit a destination; the form is generated from the driver schema. */
export const DestinationFormModal: React.FC<{
	opened: boolean;
	onClose: () => void;
	/** Edit this destination (type is fixed); omit to create. */
	destination?: DestinationDTO | null;
}> = ({ opened, onClose, destination }) => {
	const { i18n } = useLingui();
	const queryClient = useQueryClient();
	const [type, setType] = useState(destination?.type ?? "s3");
	const [name, setName] = useState(destination?.name ?? "");
	const [config, setConfig] = useState<Record<string, unknown>>(
		destination?.config ?? {},
	);
	// Checked here first so problems show under their field.
	const issues = useSchemaFormIssues();
	const clearIssues = issues.clear;
	useEffect(() => {
		if (!opened) return;
		setType(destination?.type ?? "s3");
		setName(destination?.name ?? "");
		setConfig(destination?.config ?? {});
		clearIssues();
	}, [opened, destination, clearIssues]);
	const driver = getDestinationDriver(type);
	const fields = driver ? driverFields(driver) : [];

	const save = useAppMutation({
		mutationFn: async () =>
			destination
				? await updateDestinationFn({
						data: { id: destination.id, name, type, config },
					})
				: await createDestinationFn({ data: { name, type, config } }),
		success: i18n._("Destination saved"),
		field: "config",
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: destinationsQueryOptions.queryKey,
			});
			onClose();
		},
	});

	const submit = () => {
		if (issues.check(driver?.schema, config, !!destination)) save.mutate();
	};

	const setField = (field: string, value: unknown) => {
		save.clearFieldError();
		issues.clear(field);
		setConfig((prev) => ({ ...prev, [field]: value }));
	};

	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={
				destination ? i18n._("Edit destination") : i18n._("Add destination")
			}
			size="lg"
			centered
		>
			<Stack>
				<Select
					label={i18n._("Type")}
					data={destinationDrivers.map((item) => ({
						value: item.type,
						label: i18n._(item.label),
					}))}
					value={type}
					onChange={(value) => {
						if (!value) return;
						setType(value);
						setConfig({});
					}}
					disabled={!!destination}
					allowDeselect={false}
					description={driver ? i18n._(driver.description) : undefined}
				/>
				<TextInput
					label={i18n._("Name")}
					value={name}
					onChange={(event) => setName(event.currentTarget.value)}
					required
				/>
				<SchemaFormFields
					fields={fields}
					values={config}
					onChange={setField}
					editing={!!destination}
					errors={issues.issues}
				/>
				{save.fieldError() && (
					<Text size="sm" c="red">
						{save.fieldError()}
					</Text>
				)}
				{/* Only for drivers that take credentials (secret fields). */}
				{driver && secretFieldNames(driver.schema).length > 0 && (
					<Text size="xs" c="dimmed">
						{i18n._(
							"Credentials are encrypted and only used by rclone on your servers; they are never shown again.",
						)}
					</Text>
				)}
				<Group justify="flex-end">
					<Button variant="default" onClick={onClose}>
						{i18n._("Cancel")}
					</Button>
					<Button
						loading={save.isPending}
						disabled={!name.trim()}
						onClick={submit}
					>
						{i18n._("Save")}
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
};
