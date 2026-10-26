/** 32-bit FNV-1a hash: stable, dependency-free seed → bits. */
function fnv1a(value: string): number {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

/**
 * Symmetric 5×5 identicon as an SVG document (GitHub style): the seed's
 * hash picks the hue and which cells are filled; the left half is mirrored.
 * Pure string output, rendered by our own server; nothing is fetched.
 */
export function identiconSvg(seed: string, size = 5): string {
	const hash = fnv1a(seed);
	const hue = hash % 360;
	const half = Math.ceil(size / 2);
	// Bits beyond the hue drive the cells (re-hash when 32 bits run out).
	let bits = fnv1a(`${seed}:cells`);
	let used = 0;
	const cells: string[] = [];
	for (let column = 0; column < half; column++) {
		for (let row = 0; row < size; row++) {
			if (used === 32) {
				bits = fnv1a(`${seed}:${column}:${row}`);
				used = 0;
			}
			const filled = (bits >>> used) & 1;
			used++;
			if (!filled) continue;
			cells.push(`<rect x="${column}" y="${row}" width="1" height="1"/>`);
			const mirror = size - 1 - column;
			if (mirror !== column) {
				cells.push(`<rect x="${mirror}" y="${row}" width="1" height="1"/>`);
			}
		}
	}
	const pad = 0.5;
	const box = size + pad * 2;
	return [
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-pad} ${-pad} ${box} ${box}" shape-rendering="crispEdges">`,
		`<rect x="${-pad}" y="${-pad}" width="${box}" height="${box}" fill="hsl(${hue} 30% 92%)"/>`,
		`<g fill="hsl(${hue} 55% 45%)">${cells.join("")}</g>`,
		"</svg>",
	].join("");
}
