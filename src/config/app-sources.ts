import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import type { MantineColor } from "@mantine/core";
import {
	AppWindow,
	Database,
	FileCode2,
	GitBranch,
	type LucideIcon,
} from "lucide-react";
import type { TemplateSourceType } from "#/features/templates/schema.ts";

/**
 * Where an app's software comes from (client-safe registry). Each kind maps
 * to one `source.type` of template.toml, so the marketplace lists it as a
 * template card and the wizard, the app page and the deploy pipeline pick
 * their behaviour from here (and from the server-side driver registry in
 * `#/features/apps/sources.server.ts`). Adding a source = one entry
 * here + one driver there + a template folder using its `source.type`.
 */
export interface AppSourceDefinition {
	/** `source.type` of the template(s) of this kind. */
	sourceType: TemplateSourceType;
	label: MessageDescriptor;
	description: MessageDescriptor;
	/**
	 * Icon of an app of this kind without a template logo, tinted with
	 * `color` (a template's `color` in template.toml takes precedence).
	 */
	icon: LucideIcon;
	color: MantineColor;
	/** Upstream versions: "Change version" + update preview apply. */
	versioned: boolean;
	/**
	 * Newer versions are checked and offered as updates (R4 M4): upstream
	 * releases, engine image tags, the branch tip of a repository.
	 */
	updatable: boolean;
	/**
	 * Apps of this kind are created and shown on their own pages (e.g.
	 * databases): the New app wizard links there instead of deploying.
	 */
	section?: { list: string; create: string };
}

export const appSources = {
	template: {
		sourceType: "github",
		label: msg({ id: "Template" }),
		description: msg({
			id: "A ready-made app from the marketplace, versions from upstream.",
		}),
		icon: AppWindow,
		color: "blue",
		versioned: true,
		updatable: true,
	},
	"custom-compose": {
		sourceType: "inline",
		label: msg({ id: "Custom compose" }),
		description: msg({
			id: "Your own docker-compose.yml, checked by the same safety rules.",
		}),
		icon: FileCode2,
		color: "blue",
		versioned: false,
		updatable: false,
	},
	git: {
		sourceType: "git",
		label: msg({ id: "From Git repository" }),
		description: msg({
			id: "Build your own code from a Git branch: Dockerfile, Railpack or a static site, redeployed on every push.",
		}),
		icon: GitBranch,
		color: "orange",
		versioned: false,
		updatable: true,
	},
	database: {
		sourceType: "database",
		label: msg({ id: "Database" }),
		description: msg({
			id: "PostgreSQL, MySQL, MariaDB, Valkey (Redis) or MongoDB with backups, a console and links to your apps.",
		}),
		icon: Database,
		color: "violet",
		// Versions are the engine's pinned image tags (Database → Settings).
		versioned: false,
		updatable: true,
		section: { list: "/databases", create: "/databases/new" },
	},
} as const satisfies Record<string, AppSourceDefinition>;

export type AppSourceKind = keyof typeof appSources;

export const appSourceKinds = Object.keys(appSources) as AppSourceKind[];

/** The source kind of a template's `source.type`. */
export function appSourceKindOf(sourceType: string): AppSourceKind {
	const found = appSourceKinds.find(
		(kind) => appSources[kind].sourceType === sourceType,
	);
	return found ?? "template";
}
