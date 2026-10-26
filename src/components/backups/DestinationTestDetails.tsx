import { useLingui } from "@lingui/react";
import { Code, List, Stack, ThemeIcon } from "@mantine/core";
import { Check, X } from "lucide-react";
import { destinationTestSteps } from "#/config/backup-drivers.ts";
import type { DestinationTestRecord } from "#/db/schema/backups.ts";

/** Steps of a destination test (passed or not) and the rclone output. */
export const DestinationTestDetails: React.FC<{
	result: DestinationTestRecord;
}> = ({ result }) => {
	const { i18n } = useLingui();
	return (
		<Stack gap="sm">
			<List spacing={4} size="sm">
				{result.steps.map((step) => (
					<List.Item
						key={step.step}
						icon={
							<ThemeIcon
								size={18}
								radius="xl"
								variant="light"
								color={step.ok ? "green" : "red"}
							>
								{step.ok ? (
									<Check size={12} aria-label={i18n._("Passed")} />
								) : (
									<X size={12} aria-label={i18n._("Failed")} />
								)}
							</ThemeIcon>
						}
					>
						{i18n._(destinationTestSteps[step.step])}
					</List.Item>
				))}
			</List>
			{result.detail && (
				<Code block style={{ whiteSpace: "pre-wrap" }}>
					{result.detail}
				</Code>
			)}
		</Stack>
	);
};
