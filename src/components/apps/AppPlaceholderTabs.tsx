import { useLingui } from "@lingui/react";
import { Button, Group, Select } from "@mantine/core";
import { TerminalSquare } from "lucide-react";
import { useState } from "react";
import { TerminalDrawer } from "#/components/servers/TerminalDrawer";
import { EmptyState } from "#/components/ui/EmptyState";
import { SectionCard } from "#/components/ui/SectionCard";
import type { AppOverview } from "#/features/apps/schema.ts";

/** Shell inside one of the app's service containers. */
export const AppTerminalTab: React.FC<{ overview: AppOverview }> = ({
	overview,
}) => {
	const { i18n } = useLingui();
	const { app, services } = overview;
	const [service, setService] = useState<string | null>(
		services.length === 1 ? services[0] : null,
	);
	const [open, setOpen] = useState(false);
	if (services.length === 0) {
		return (
			<SectionCard>
				<EmptyState
					compact
					icon={TerminalSquare}
					title={i18n._("Container terminal")}
					description={i18n._("Available after the first deploy.")}
				/>
			</SectionCard>
		);
	}
	return (
		<SectionCard
			title={i18n._("Container terminal")}
			description={i18n._(
				"Opens a shell inside the selected service container (bash when available, otherwise sh).",
			)}
		>
			<Group align="flex-end">
				<Select
					label={i18n._("Service")}
					data={services}
					value={service}
					onChange={setService}
					w={240}
				/>
				<Button
					leftSection={<TerminalSquare size={16} />}
					disabled={!service}
					onClick={() => setOpen(true)}
				>
					{i18n._("Open terminal")}
				</Button>
			</Group>
			<TerminalDrawer
				opened={open}
				onClose={() => setOpen(false)}
				wsPath={`/api/apps/${encodeURIComponent(app.id)}/terminal?service=${encodeURIComponent(service ?? "")}`}
				serverName={`${app.name} · ${service ?? ""}`}
			/>
		</SectionCard>
	);
};
