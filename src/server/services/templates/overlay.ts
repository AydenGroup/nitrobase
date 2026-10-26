import { parse as parseYaml } from "yaml";
import { assertNoMergeKeys, isObj } from "./compose-policy";
import { TemplateError } from "./naming";

type Obj = Record<string, unknown>;

/**
 * Deep-merge a template's compose overlay onto the (upstream) compose model:
 * mappings merge key by key, lists and scalars replace, `null` removes the
 * key (e.g. `services: { traefik: null }`). Pure: returns a new object.
 * The result goes through the same transform and policy as any compose.
 */
export function mergeOverlay(base: unknown, overlay: unknown): unknown {
	if (overlay === undefined) return structuredClone(base);
	if (!isObj(base) || !isObj(overlay)) return structuredClone(overlay);
	const out: Obj = structuredClone(base);
	for (const [key, value] of Object.entries(overlay)) {
		if (value === null) delete out[key];
		else
			out[key] =
				key in out ? mergeOverlay(out[key], value) : structuredClone(value);
	}
	return out;
}

/** Parse an overlay file (same YAML rules as compose files). */
export function parseOverlay(text: string): Obj {
	const parsed = parseYaml(text, { merge: true, maxAliasCount: 100 });
	if (parsed === null || parsed === undefined) return {};
	assertNoMergeKeys(parsed, "overlay");
	if (!isObj(parsed)) throw new TemplateError("COMPOSE_OVERLAY_NOT_MAPPING");
	return parsed;
}

/** Parse a compose file and apply the overlay(s) (when any), in order. */
export function composeWithOverlay(
	compose: string,
	overlay: string | null | (string | null)[],
): Obj {
	const parsed = parseYaml(compose, { merge: true, maxAliasCount: 100 });
	if (!isObj(parsed)) throw new TemplateError("COMPOSE_NOT_MAPPING");
	let merged: unknown = parsed;
	for (const text of Array.isArray(overlay) ? overlay : [overlay]) {
		if (!text) continue;
		merged = mergeOverlay(merged, parseOverlay(text));
		if (!isObj(merged)) throw new TemplateError("COMPOSE_NOT_MAPPING");
	}
	return merged as Obj;
}
