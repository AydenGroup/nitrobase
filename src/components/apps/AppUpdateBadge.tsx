import { useLingui } from "@lingui/react";
import { Badge, Tooltip } from "@mantine/core";
import { ArrowUpCircle } from "lucide-react";
import type { AppUpdateView } from "#/features/app-updates/schema.ts";
import { updateKindLabels } from "./update-labels";

/** "Update available" with the target version in a tooltip. */
export const AppUpdateBadge: React.FC<{
	update: AppUpdateView | undefined;
	compact?: boolean;
}> = ({ update, compact }) => {
	const { i18n } = useLingui();
	if (!update?.available) return null;
	const label = i18n._("{from} → {to} ({kind})", {
		from: update.current,
		to: update.name ?? update.version ?? "",
		kind: update.kind ? i18n._(updateKindLabels[update.kind]) : "",
	});
	return (
		<Tooltip label={label}>
			<Badge
				color="brand"
				variant="light"
				size={compact ? "xs" : "sm"}
				leftSection={<ArrowUpCircle size={compact ? 10 : 12} />}
				aria-label={i18n._("Update available: {version}", { version: label })}
			>
				{compact ? i18n._("Update") : i18n._("Update available")}
			</Badge>
		</Tooltip>
	);
};
