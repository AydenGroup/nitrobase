export type Selection = { kind: "function" | "shared"; name: string } | null;

/**
 * The entry the editor shows: the selected one while it still exists in its
 * own list, else the first function, else the first shared folder, else none.
 */
export function resolveSelection(
	selected: Selection,
	functions: { name: string }[],
	shared: { name: string }[],
): Selection {
	if (
		selected &&
		(selected.kind === "function" ? functions : shared).some(
			(item) => item.name === selected.name,
		)
	) {
		return selected;
	}
	if (functions[0]) return { kind: "function", name: functions[0].name };
	if (shared[0]) return { kind: "shared", name: shared[0].name };
	return null;
}
