/**
 * Entry of a label/meta registry for a key that arrives as a plain string
 * (DB text, Docker state, server registry id). Registries are typed
 * `satisfies Record<Union, …>` so a new union member without a label is a
 * compile error; this is the one place a string is narrowed to that union.
 */
export function lookup<K extends string, V>(
	registry: Record<K, V>,
	key: string | null | undefined,
): V | undefined {
	return key != null && Object.hasOwn(registry, key)
		? registry[key as K]
		: undefined;
}
