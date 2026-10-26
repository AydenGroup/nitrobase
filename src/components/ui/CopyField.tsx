import { Code, Group } from "@mantine/core";
import { CopyIconButton } from "./CopyIconButton";

/** Monospace value with a copy button (`block`: multi-line snippet). */
export const CopyField: React.FC<{
	value: string;
	display?: string;
	block?: boolean;
}> = ({ value, display, block = false }) => {
	return (
		<Group
			gap={4}
			wrap="nowrap"
			align={block ? "flex-start" : "center"}
			style={{ minWidth: 0 }}
		>
			<Code
				block={block}
				style={{
					flex: 1,
					minWidth: 0,
					wordBreak: "break-all",
					whiteSpace: block ? "pre-wrap" : undefined,
				}}
			>
				{display ?? value}
			</Code>
			<CopyIconButton value={value} />
		</Group>
	);
};
