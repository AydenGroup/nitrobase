import { assertEnvLines, SECRET_MASK } from "#/libs/env-file.ts";
import {
	assertUserEnvName,
	TemplateError,
} from "#/server/services/templates/naming.ts";
import {
	parseEnvFile,
	referencedVariables,
	renderEnvFile,
	tokenize,
} from "#/server/services/templates/variables.ts";

export { SECRET_MASK };

/** Render builtins that come from the primary domain (see render.ts). */
const DOMAIN_BUILTINS = new Set(["domain", "url"]);

const GENERATORS = new Set([
	"password",
	"base64",
	"hex",
	"uuid",
	"jwt",
	"bcrypt",
	"opaque_key",
	"signing_keys",
	"jwt_es256",
	// `jwks` is intentionally absent: it is derived (no randomness), so it is
	// recomputed on every render from the carried-over signing keys
	// (JWT_KEYS), and a rotation of those keys updates it automatically.
]);

/** True when an expression produces random/non-reproducible output. */
export function isGeneratedExpression(expression: string): boolean {
	return tokenize(expression).some(
		(token) =>
			token.kind === "expr" && GENERATORS.has(token.expr.split(":")[0]),
	);
}

/**
 * Values to carry over into the next render: only generated ones (secrets,
 * JWTs), so derived values (URLs from the domain, versions) recompute.
 * A generator never yields an empty value: an empty previous value is an
 * upstream default the template has since started generating (e.g. a key
 * upstream ships empty), so it is generated on this render.
 */
export function carryOverValues(
	definitions: Record<string, string>,
	previous: Record<string, string>,
	/**
	 * Names kept whatever their expression: template `initial_only`
	 * variables the app was initialised with (`frozenInitialValues`), so
	 * e.g. an admin email built from the domain stays the one the app
	 * created its account with.
	 */
	frozen: ReadonlySet<string> = new Set(),
): Record<string, string> {
	const kept: Record<string, string> = {};
	for (const [name, expression] of Object.entries(definitions)) {
		if (
			name in previous &&
			previous[name] !== "" &&
			(frozen.has(name) || isGeneratedExpression(expression))
		) {
			kept[name] = previous[name];
		}
	}
	return kept;
}

/**
 * Template `initial_only` variables whose value is frozen: those the app
 * was initialised with (`initialised`, the names in its env when a deploy
 * first reached `compose up`; null: never started). It read them then and
 * ignores later values. Before that, and for one a template update added
 * since (never applied), they behave like any other variable.
 */
export function frozenInitialValues(
	variables: Record<string, { initial_only?: boolean }>,
	initialised: readonly string[] | null,
): Set<string> {
	return new Set(
		(initialised ?? []).filter((name) => variables[name]?.initial_only),
	);
}

/**
 * The `initial_only` variables an app initialises its data with, from the
 * env of the deploy that first reaches `compose up` (the
 * `AppInputs.initialised` marker).
 */
export function initialisedNames(
	variables: Record<string, { initial_only?: boolean }>,
	values: Record<string, string>,
): string[] {
	return Object.keys(values).filter((name) => variables[name]?.initial_only);
}

/**
 * Variables whose value comes (directly or through other variables) from
 * the app's domain (builtins `${domain}` and `${url}`): a clone on a new
 * domain recomputes them.
 */
export function domainDerivedVariables(
	definitions: Record<string, string>,
): Set<string> {
	const direct = Object.entries(definitions)
		.filter(([, expression]) =>
			tokenize(expression).some(
				(token) =>
					token.kind === "expr" &&
					DOMAIN_BUILTINS.has(token.expr.split(":")[0]),
			),
		)
		.map(([name]) => name);
	return new Set([...direct, ...dependentsOf(definitions, direct)]);
}

/**
 * Values a rotation of `name` drops so the next render regenerates them:
 * it and its dependents, except frozen initial_only values (the app
 * ignores a new one, so they keep the value it was initialised with).
 */
export function rotationDrops(
	definitions: Record<string, string>,
	name: string,
	frozen: ReadonlySet<string>,
): Set<string> {
	return new Set(
		[name, ...dependentsOf(definitions, [name])].filter(
			(key) => !frozen.has(key),
		),
	);
}

/** Variables that (transitively) depend on any of `changed`. */
export function dependentsOf(
	definitions: Record<string, string>,
	changed: Iterable<string>,
): Set<string> {
	const reverse = new Map<string, Set<string>>();
	for (const [name, expression] of Object.entries(definitions)) {
		for (const ref of referencedVariables(expression)) {
			if (!reverse.has(ref)) reverse.set(ref, new Set());
			reverse.get(ref)?.add(name);
		}
	}
	const out = new Set<string>();
	const queue = [...changed];
	while (queue.length) {
		const current = queue.shift() as string;
		for (const dependent of reverse.get(current) ?? []) {
			if (!out.has(dependent)) {
				out.add(dependent);
				queue.push(dependent);
			}
		}
	}
	return out;
}

/** Render values as a `.env` text with secret values masked. */
export function maskedEnvText(
	values: Record<string, string>,
	secrets: Set<string>,
): string {
	return renderEnvFile(
		Object.fromEntries(
			Object.entries(values).map(([name, value]) => [
				name,
				secrets.has(name) && value !== "" ? SECRET_MASK : value,
			]),
		),
	);
}

export interface EnvEditResult {
	/** New user overrides (template + custom variables). */
	overrides: Record<string, string>;
	/** Current values with edits applied (dependents dropped for re-render). */
	values: Record<string, string>;
	changed: string[];
	removed: string[];
	/** Template variables missing from the paste (kept, cannot be removed). */
	kept: string[];
}

/**
 * Apply a bulk `.env` paste to an app's env state.
 * - A masked value (`********`) keeps the stored value.
 * - Template variables can't be deleted: omitting one keeps it.
 * - Custom variables omitted from the paste are removed.
 * - Changing a variable drops generated values that depend on it (e.g. a new
 *   JWT_SECRET re-signs ANON_KEY) so the next deploy regenerates them.
 */
export function applyEnvEdit(
	input: EnvEditInput & { pasted: string },
): EnvEditResult {
	assertEnvLines(input.pasted);
	const parsed = parseEnvFile(input.pasted);
	for (const name of Object.keys(parsed)) assertUserEnvName(name);
	return applyParsedEnv(parsed, input);
}

interface EnvEditInput {
	values: Record<string, string>;
	overrides: Record<string, string>;
	templateKeys: Set<string>;
	definitions: Record<string, string>;
}

/**
 * Apply only the variables the structured editor changed: `set` (new or
 * edited values) and `remove` (custom variables to delete). Values not
 * named are never re-submitted, so a stale copy (e.g. revealed secrets) can't
 * overwrite a newer stored value. Same rules as `applyEnvEdit` otherwise; the
 * secret mask itself is not a value (it would read as "keep").
 */
export function applyEnvChanges(
	input: EnvEditInput & { set: Record<string, string>; remove: string[] },
): EnvEditResult {
	for (const [name, value] of Object.entries(input.set)) {
		assertUserEnvName(name);
		if (value === SECRET_MASK) {
			throw new TemplateError("ENV_VALUE_MASKED", { name });
		}
	}
	const remove = new Set(input.remove);
	const parsed: Record<string, string> = {};
	for (const name of Object.keys(input.values)) {
		if (!remove.has(name)) parsed[name] = SECRET_MASK;
	}
	return applyParsedEnv({ ...parsed, ...input.set }, input);
}

function applyParsedEnv(
	parsed: Record<string, string>,
	input: EnvEditInput,
): EnvEditResult {
	const overrides = { ...input.overrides };
	const values = { ...input.values };
	const changed: string[] = [];
	const removed: string[] = [];
	const kept: string[] = [];

	for (const [name, value] of Object.entries(parsed)) {
		if (value === SECRET_MASK) continue;
		if (values[name] === value) continue;
		overrides[name] = value;
		values[name] = value;
		changed.push(name);
	}
	for (const name of Object.keys(values)) {
		if (name in parsed) continue;
		if (input.templateKeys.has(name)) {
			kept.push(name);
			continue;
		}
		delete values[name];
		delete overrides[name];
		removed.push(name);
	}
	for (const dependent of dependentsOf(input.definitions, changed)) {
		if (dependent in parsed && changed.includes(dependent)) continue;
		delete values[dependent];
		delete overrides[dependent];
	}
	return { overrides, values, changed, removed, kept };
}

export interface EnvResetResult {
	overrides: Record<string, string>;
	values: Record<string, string>;
	/** Template variables whose override was dropped. */
	reset: string[];
	/** Derived values dropped for re-render (no override of theirs touched). */
	touched: string[];
	/**
	 * Generated values to keep in the stored env: a reset generated variable
	 * keeps its current value, now managed (carried over) by the template.
	 */
	keepStored: Record<string, string>;
}

/**
 * Hand overridden template variables back to the template:
 * - a generated one (password, key) keeps its current value: only the
 *   override goes, and the value stays in the stored env, so the next deploy
 *   carries it over unchanged (Rotate is how to get a new one);
 * - any other one drops its override and stored value, so the next render
 *   computes the template's value; generated values derived from it (without
 *   an override of their own) are dropped to be re-derived.
 * Overrides of dependents are never touched. Names that are not overridden
 * template variables are skipped.
 */
export function applyEnvReset(
	edit: Pick<EnvEditResult, "overrides" | "values">,
	names: Iterable<string>,
	input: { templateKeys: Set<string>; definitions: Record<string, string> },
): EnvResetResult {
	const overrides = { ...edit.overrides };
	const values = { ...edit.values };
	const reset = [...new Set(names)].filter(
		(name) => input.templateKeys.has(name) && name in overrides,
	);
	const dropped: string[] = [];
	const keepStored: Record<string, string> = {};
	for (const name of reset) {
		delete overrides[name];
		const expression = input.definitions[name];
		if (expression !== undefined && isGeneratedExpression(expression)) {
			if (name in values) keepStored[name] = values[name];
			continue;
		}
		delete values[name];
		dropped.push(name);
	}
	const touched: string[] = [];
	for (const dependent of dependentsOf(input.definitions, dropped)) {
		if (dependent in overrides || !(dependent in values)) continue;
		delete values[dependent];
		touched.push(dependent);
	}
	return { overrides, values, reset, touched, keepStored };
}

/**
 * Env edits and frozen `initial_only` variables (`frozenInitialValues`):
 * changing, removing or resetting one is refused (the app ignores it now),
 * and when an edit of another variable drops one as a dependent, its
 * previous value and override are put back.
 */
export function keepFrozenValues(
	frozen: ReadonlySet<string>,
	edited: Iterable<string>,
	before: Pick<EnvEditResult, "values" | "overrides">,
	after: Pick<EnvEditResult, "values" | "overrides">,
): Pick<EnvEditResult, "values" | "overrides"> {
	for (const name of edited) {
		if (frozen.has(name)) {
			throw new TemplateError("ENV_INITIAL_ONLY", { name });
		}
	}
	const values = { ...after.values };
	const overrides = { ...after.overrides };
	for (const name of frozen) {
		if (name in before.values && !(name in values)) {
			values[name] = before.values[name];
		}
		if (name in before.overrides && !(name in overrides)) {
			overrides[name] = before.overrides[name];
		}
	}
	return { values, overrides };
}

/**
 * Apply set/remove edits to a service-scoped secret env. Names must be valid
 * env names, not set by the service's compose `environment` (that would
 * silently win), and the total stays under `maxVars`.
 */
export function editServiceEnv(
	current: Record<string, string>,
	edit: { set: Record<string, string>; remove: string[] },
	options: { reserved: Set<string>; maxVars: number },
): Record<string, string> {
	const next = { ...current };
	for (const name of edit.remove) delete next[name];
	for (const [name, value] of Object.entries(edit.set)) {
		assertUserEnvName(name);
		if (options.reserved.has(name)) {
			throw new TemplateError("ENV_TEMPLATE_OWNED", { name });
		}
		next[name] = value;
	}
	if (Object.keys(next).length > options.maxVars) {
		throw new TemplateError("ENV_TOO_MANY", { max: options.maxVars });
	}
	return next;
}
