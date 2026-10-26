import type { MessageDescriptor } from "@lingui/core";
import type { LucideIcon } from "lucide-react";
import type { ComponentType } from "react";
import type { Permission } from "#/config/permissions.ts";
import type { AppOverview } from "#/features/apps/schema.ts";

/**
 * What a provider plugin adds to apps of its template (e.g. "api-keys",
 * "edge-functions"). An open id: each plugin declares its own in
 * `capabilities` (kebab-case, checked by the registry test), so a third-party
 * plugin needs no change here. Server functions check them
 * (`assertAppCapability`) before doing plugin work.
 */
export type PluginCapability = string;

/** Capability ids: lowercase kebab-case. */
export const CAPABILITY_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export interface PluginTabProps {
	overview: AppOverview;
}

export interface PluginTab {
	/** Tab id in the app page URL (`?tab=`); unique across plugins. */
	id: string;
	label: MessageDescriptor;
	/** Icon in the app page's tab list. */
	icon: LucideIcon;
	/** The tab is shown only when the plugin declares this capability. */
	capability: PluginCapability;
	/** Shown only when the active team role grants it (default: app.view). */
	permission?: Permission;
	/** Lazy component (client-only chunk). */
	load: () => Promise<{ default: ComponentType<PluginTabProps> }>;
}

/** A provider plugin: one per template id, registered in `registry.ts`. */
export interface ProviderPlugin {
	templateId: string;
	capabilities: PluginCapability[];
	tabs: PluginTab[];
}
