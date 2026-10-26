import { Group, Text, ThemeIcon } from "@mantine/core";
import { Database, Leaf, type LucideIcon, Zap } from "lucide-react";
import {
	type DatabaseEngineId,
	databaseEngines,
} from "#/config/database-engines.ts";

/** Engine icons (the registry holds names and colors). */
const engineIcons = {
	postgres: Database,
	mysql: Database,
	mariadb: Database,
	valkey: Zap,
	mongodb: Leaf,
} satisfies Record<DatabaseEngineId, LucideIcon>;

/** Engine icon, product name and (optionally) version. */
export const EngineBadge: React.FC<{
	engine: DatabaseEngineId;
	version?: string;
	size?: "sm" | "md";
}> = ({ engine, version, size = "sm" }) => {
	const Icon = engineIcons[engine];
	const definition = databaseEngines[engine];
	return (
		<Group gap={8} wrap="nowrap">
			<ThemeIcon
				variant="light"
				color={definition.color}
				size={size === "sm" ? "md" : "lg"}
				radius="md"
			>
				<Icon size={size === "sm" ? 14 : 18} />
			</ThemeIcon>
			<Text size={size} fw={500}>
				{definition.name}
				{version ? (
					<Text span c="dimmed" size={size} ml={6} ff="monospace">
						{version}
					</Text>
				) : null}
			</Text>
		</Group>
	);
};
