import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

/**
 * Marketplace categories (template.toml `category`). Unknown categories
 * still work: they show their id. Adding one = one entry here.
 */
export type TemplateCategoryId =
	| "backend"
	| "automation"
	| "storage"
	| "databases"
	| "analytics"
	| "custom"
	| "other";

export const templateCategories = {
	backend: msg({ id: "Backend" }),
	automation: msg({ id: "Automation" }),
	storage: msg({ id: "Storage" }),
	databases: msg({ id: "Databases" }),
	analytics: msg({ id: "Analytics" }),
	custom: msg({ id: "Custom" }),
	other: msg({ id: "Other" }),
} satisfies Record<TemplateCategoryId, MessageDescriptor>;
