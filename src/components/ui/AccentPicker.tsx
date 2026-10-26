import { useLingui } from "@lingui/react";
import { Group, Tooltip, UnstyledButton } from "@mantine/core";
import { useRef } from "react";
import { ACCENTS, type AccentId } from "#/theme/accents.ts";

const DOT_SIZE = 16;

/** Row of color dots (a radio group) to choose the accent color. */
export const AccentPicker: React.FC<{
	value: AccentId;
	onChange: (id: AccentId) => void;
}> = ({ value, onChange }) => {
	const { i18n } = useLingui();
	const group = useRef<HTMLDivElement>(null);

	const move = (event: React.KeyboardEvent, step: 1 | -1) => {
		event.preventDefault();
		// Arrow keys also drive the surrounding menu; keep them for the dots.
		event.stopPropagation();
		const index = ACCENTS.findIndex((accent) => accent.id === value);
		const next = ACCENTS[(index + step + ACCENTS.length) % ACCENTS.length];
		onChange(next.id);
		group.current
			?.querySelector<HTMLElement>(`[data-accent-id="${next.id}"]`)
			?.focus();
	};

	return (
		<Group
			ref={group}
			role="radiogroup"
			aria-label={i18n._("Accent color")}
			gap={6}
			wrap="nowrap"
			onKeyDown={(event) => {
				if (event.key === "ArrowRight" || event.key === "ArrowDown")
					move(event, 1);
				if (event.key === "ArrowLeft" || event.key === "ArrowUp")
					move(event, -1);
			}}
		>
			{ACCENTS.map((accent) => {
				const label = i18n._(accent.label);
				const checked = accent.id === value;
				return (
					<Tooltip key={accent.id} label={label} withArrow>
						<UnstyledButton
							role="radio"
							aria-checked={checked}
							aria-label={label}
							data-accent-id={accent.id}
							tabIndex={checked ? 0 : -1}
							onClick={() => onChange(accent.id)}
							style={{
								width: DOT_SIZE,
								height: DOT_SIZE,
								borderRadius: "50%",
								background: accent.swatch,
								border: "1px solid var(--sb-border-strong)",
								outline: checked ? "2px solid var(--sb-text-1)" : "none",
								outlineOffset: 2,
							}}
						/>
					</Tooltip>
				);
			})}
		</Group>
	);
};
