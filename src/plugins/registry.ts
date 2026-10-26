import { appwritePlugin } from "./appwrite/plugin";
import { supabasePlugin } from "./supabase/plugin";
import type { PluginCapability, PluginTab, ProviderPlugin } from "./types";

/** Registered provider plugins. Adding a provider = one module + one entry. */
export const providerPlugins: ProviderPlugin[] = [
	supabasePlugin,
	appwritePlugin,
];

export function pluginFor(templateId: string): ProviderPlugin | undefined {
	return providerPlugins.find((plugin) => plugin.templateId === templateId);
}

export function hasCapability(
	templateId: string,
	capability: PluginCapability,
): boolean {
	return !!pluginFor(templateId)?.capabilities.includes(capability);
}

/** Plugin tabs for an app page, in plugin order. */
export function pluginTabsFor(templateId: string): PluginTab[] {
	const plugin = pluginFor(templateId);
	if (!plugin) return [];
	return plugin.tabs.filter((tab) =>
		plugin.capabilities.includes(tab.capability),
	);
}
