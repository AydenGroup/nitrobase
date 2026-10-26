import { useLingui } from "@lingui/react";
import { Badge, Group, List, Stack, Text, ThemeIcon } from "@mantine/core";
import { Check, Minus, X } from "lucide-react";
import { CodedList } from "#/components/ui/CodedList";
import { ErrorText } from "#/components/ui/ErrorText";
import { KeyValueList } from "#/components/ui/KeyValueList";
import {
	type CloudSyncProvider,
	connectionInfoLabel,
	connectionTestStepLabel,
	syncDirectionLabels,
} from "#/config/cloud-sync.ts";
import { lookup } from "#/config/labels.ts";
import type { CloudConnectionTestRecord } from "#/db/schema/cloud-sync.ts";

/** Steps of a connection test, what the provider reported, and notes. */
export const ConnectionTestDetails: React.FC<{
	/** The connection's provider (labels its steps and info). */
	provider: CloudSyncProvider | null;
	result: CloudConnectionTestRecord;
}> = ({ provider, result }) => {
	const { i18n } = useLingui();
	const info = Object.entries(result.info);
	const stepLabel = (step: string) => {
		const label = connectionTestStepLabel(provider, step);
		return label ? i18n._(label) : step;
	};
	return (
		<Stack gap="md">
			<List spacing={6} size="sm">
				{result.steps.map((step) => (
					<List.Item
						key={step.step}
						icon={
							<ThemeIcon
								size={18}
								radius="xl"
								variant="light"
								color={step.skipped ? "gray" : step.ok ? "green" : "red"}
							>
								{step.skipped ? (
									<Minus size={12} aria-label={i18n._("Skipped")} />
								) : step.ok ? (
									<Check size={12} aria-label={i18n._("Passed")} />
								) : (
									<X size={12} aria-label={i18n._("Failed")} />
								)}
							</ThemeIcon>
						}
					>
						<Stack gap={2}>
							<Text size="sm">
								{stepLabel(step.step)}{" "}
								{step.skipped && (
									<Badge size="xs" variant="light" color="gray">
										{i18n._("skipped")}
									</Badge>
								)}
							</Text>
							{step.error && <ErrorText error={step.error} c="red" size="xs" />}
						</Stack>
					</List.Item>
				))}
			</List>
			{result.directions.length > 0 && (
				<Stack gap={4}>
					{result.directions.map((item) => {
						const label = lookup(syncDirectionLabels, item.direction);
						return (
							<Stack key={item.direction} gap={2}>
								<Group gap="xs">
									<Text size="sm">
										{label ? i18n._(label) : item.direction}
									</Text>
									<Badge
										size="xs"
										variant="light"
										color={item.ok ? "green" : "red"}
									>
										{item.ok ? i18n._("possible") : i18n._("not possible")}
									</Badge>
								</Group>
								{!item.ok && item.reason && (
									<ErrorText error={item.reason} c="red" size="xs" />
								)}
							</Stack>
						);
					})}
				</Stack>
			)}
			{info.length > 0 && (
				<KeyValueList
					items={info.map(([key, value]) => {
						const label = connectionInfoLabel(provider, key);
						return { key, label: label ? i18n._(label) : key, value };
					})}
				/>
			)}
			{result.warnings.length > 0 && (
				<CodedList items={result.warnings} c="yellow.8" />
			)}
		</Stack>
	);
};
