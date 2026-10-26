/** The first `limit` characters of `text` (limits: `#/config/text-limits.ts`). */
export function clip(text: string, limit: number): string {
	return text.length > limit ? text.slice(0, limit) : text;
}

/** The last `limit` characters of `text` (error output: the end matters). */
export function clipEnd(text: string, limit: number): string {
	return text.length > limit ? text.slice(-limit) : text;
}

/** Names used by more than one item (show a disambiguator next to them). */
export function duplicateNames(items: { name: string }[]): Set<string> {
	const seen = new Set<string>();
	const duplicates = new Set<string>();
	for (const item of items) {
		const key = item.name.trim().toLowerCase();
		if (seen.has(key)) duplicates.add(key);
		seen.add(key);
	}
	return duplicates;
}
