export type DiffLine = { kind: "same" | "add" | "remove"; text: string };

const MAX_CELLS = 4_000_000;

/** Line diff (LCS). Falls back to remove-all/add-all for huge inputs. */
export function diffLines(before: string, after: string): DiffLine[] {
	const a = before.split("\n");
	const b = after.split("\n");
	if (a.length * b.length > MAX_CELLS) {
		return [
			...a.map((text) => ({ kind: "remove" as const, text })),
			...b.map((text) => ({ kind: "add" as const, text })),
		];
	}
	const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
		new Array<number>(b.length + 1).fill(0),
	);
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			lcs[i][j] =
				a[i] === b[j]
					? lcs[i + 1][j + 1] + 1
					: Math.max(lcs[i + 1][j], lcs[i][j + 1]);
		}
	}
	const out: DiffLine[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) {
			out.push({ kind: "same", text: a[i] });
			i++;
			j++;
		} else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
			out.push({ kind: "remove", text: a[i++] });
		} else {
			out.push({ kind: "add", text: b[j++] });
		}
	}
	while (i < a.length) out.push({ kind: "remove", text: a[i++] });
	while (j < b.length) out.push({ kind: "add", text: b[j++] });
	return out;
}

/** Unified-diff style text with `context` unchanged lines around changes. */
export function formatUnifiedDiff(lines: DiffLine[], context = 3): string {
	if (lines.every((line) => line.kind === "same")) return "";
	const keep = new Array<boolean>(lines.length).fill(false);
	lines.forEach((line, index) => {
		if (line.kind === "same") return;
		for (
			let k = Math.max(0, index - context);
			k <= Math.min(lines.length - 1, index + context);
			k++
		) {
			keep[k] = true;
		}
	});
	const out: string[] = [];
	let skipped = false;
	lines.forEach((line, index) => {
		if (!keep[index]) {
			skipped = true;
			return;
		}
		if (skipped) out.push("@@");
		skipped = false;
		out.push(
			`${line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "}${line.text}`,
		);
	});
	if (skipped) out.push("@@");
	return out.join("\n");
}

export interface EnvDiff {
	added: string[];
	removed: string[];
	changed: string[];
}

/** Key-level env diff (values never included: they may be secrets). */
export function diffEnvKeys(
	before: Record<string, string>,
	after: Record<string, string>,
): EnvDiff {
	const added = Object.keys(after).filter((key) => !(key in before));
	const removed = Object.keys(before).filter((key) => !(key in after));
	const changed = Object.keys(after).filter(
		(key) => key in before && before[key] !== after[key],
	);
	return { added, removed, changed };
}
