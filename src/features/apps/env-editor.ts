import type { ErrorInfo } from "#/libs/coded.ts";
import {
	assertEnvLines,
	parseEnvFile,
	renderEnvFile,
	SECRET_MASK,
} from "#/libs/env-file.ts";
import { assertUserEnvName, TemplateError } from "#/libs/naming-rules.ts";
import { AppError } from "#/utils/error.ts";
import type { AppEnvVariable } from "./schema";

/**
 * Env editor drafts (client-side, pure): the structured form and the raw
 * `.env` text ("Developer view") edit the same draft, a name -> value map
 * in display order. Secret values stay masked (`SECRET_MASK`) until an
 * audited reveal; a masked value is kept by the server on save.
 */
export type EnvDraft = Record<string, string>;

type EnvSectionKind = "general" | "group" | "custom";

export interface EnvSection {
	/** Stable id (accordion value). */
	id: string;
	kind: EnvSectionKind;
	/** Template text heading (kind "group"), translated at render. */
	title?: string;
	names: string[];
}

/**
 * Sections of the form: template variables without a group ("General"),
 * then one per template group in template order, then the custom
 * variables (always present: it holds the "add variable" row) including
 * ones only in the draft (just added).
 */
export function envSections(
	variables: AppEnvVariable[],
	draft: EnvDraft,
): EnvSection[] {
	const general: EnvSection = { id: "general", kind: "general", names: [] };
	const groups = new Map<string, EnvSection>();
	const custom: EnvSection = { id: "custom", kind: "custom", names: [] };
	const known = new Set<string>();
	for (const variable of variables) {
		known.add(variable.name);
		if (!variable.template) {
			if (variable.name in draft) custom.names.push(variable.name);
			continue;
		}
		if (!variable.group) {
			general.names.push(variable.name);
			continue;
		}
		let section = groups.get(variable.group);
		if (!section) {
			section = {
				id: `group:${variable.group}`,
				kind: "group",
				title: variable.group,
				names: [],
			};
			groups.set(variable.group, section);
		}
		section.names.push(variable.name);
	}
	for (const name of Object.keys(draft)) {
		if (!known.has(name)) custom.names.push(name);
	}
	return [
		...(general.names.length ? [general] : []),
		...groups.values(),
		custom,
	];
}

export interface EnvChanges {
	/** Values edited (incl. a template variable dropped from the text: kept). */
	changed: string[];
	added: string[];
	/** Custom variables deleted. */
	removed: string[];
	/** Template variables reset to the template value. */
	reset: string[];
}

/** What a save would change, compared with the loaded env. */
export function diffEnvDraft(
	base: EnvDraft,
	draft: EnvDraft,
	reset: ReadonlySet<string>,
): EnvChanges {
	const changes: EnvChanges = {
		changed: [],
		added: [],
		removed: [],
		reset: [],
	};
	for (const [name, value] of Object.entries(draft)) {
		if (!(name in base)) changes.added.push(name);
		else if (reset.has(name)) changes.reset.push(name);
		else if (base[name] !== value) changes.changed.push(name);
	}
	for (const name of Object.keys(base)) {
		if (!(name in draft)) changes.removed.push(name);
	}
	return changes;
}

export function countEnvChanges(changes: EnvChanges): number {
	return (
		changes.changed.length +
		changes.added.length +
		changes.removed.length +
		changes.reset.length
	);
}

/**
 * What a save sends: only changed or added values (`set`), deleted custom
 * variables and resets, so unchanged values (e.g. revealed secrets) are
 * never re-submitted. The mask itself is refused as a value (coded), like
 * the server does.
 */
export function envSavePayload(
	base: EnvDraft,
	draft: EnvDraft,
	reset: ReadonlySet<string>,
): { set: Record<string, string>; remove: string[]; reset: string[] } {
	const changes = diffEnvDraft(base, draft, reset);
	const set: Record<string, string> = {};
	for (const name of [...changes.changed, ...changes.added]) {
		if (draft[name] === SECRET_MASK) {
			throw new TemplateError("ENV_VALUE_MASKED", { name });
		}
		set[name] = draft[name];
	}
	return { set, remove: changes.removed, reset: changes.reset };
}

/** Draft as a `.env` text (Developer view). */
export function draftToText(draft: EnvDraft): string {
	return renderEnvFile(draft);
}

/**
 * Developer view text back to a draft. Throws coded errors (invalid lines
 * or names) like the server would. Template variables missing from the
 * text are kept (the server keeps them too), with their current value.
 */
export function draftFromText(
	text: string,
	current: EnvDraft,
	templateNames: ReadonlySet<string>,
): EnvDraft {
	assertEnvLines(text);
	const parsed = parseEnvFile(text);
	for (const name of Object.keys(parsed)) assertUserEnvName(name);
	const draft: EnvDraft = {};
	for (const [name, value] of Object.entries(current)) {
		if (name in parsed) draft[name] = parsed[name];
		else if (templateNames.has(name)) draft[name] = value;
	}
	for (const [name, value] of Object.entries(parsed)) {
		if (!(name in draft)) draft[name] = value;
	}
	return draft;
}

/** The coded problem of a new variable's name, if any. */
export function envNameProblem(
	name: string,
	draft: EnvDraft,
): ErrorInfo | "duplicate" | null {
	try {
		assertUserEnvName(name);
	} catch (error) {
		if (error instanceof AppError) {
			return { code: error.code, params: error.params } as ErrorInfo;
		}
		throw error;
	}
	return name in draft ? "duplicate" : null;
}

/**
 * After an audited reveal: the plain values become the base, and draft
 * values still equal to the (masked) base take the plain value.
 */
export function applyRevealed(
	base: EnvDraft,
	draft: EnvDraft,
	plain: EnvDraft,
): { base: EnvDraft; draft: EnvDraft } {
	const nextBase = { ...base };
	const nextDraft = { ...draft };
	for (const [name, value] of Object.entries(plain)) {
		if (!(name in base)) continue;
		if (name in draft && draft[name] === base[name]) nextDraft[name] = value;
		nextBase[name] = value;
	}
	return { base: nextBase, draft: nextDraft };
}

/** A masked secret (value hidden until a reveal). */
export function isMasked(value: string | undefined): boolean {
	return value === SECRET_MASK;
}

/** Case-insensitive search over a variable's name and texts. */
export function matchesEnvQuery(
	query: string,
	texts: (string | undefined)[],
): boolean {
	const needle = query.trim().toLowerCase();
	if (!needle) return true;
	return texts.some((text) => text?.toLowerCase().includes(needle));
}
