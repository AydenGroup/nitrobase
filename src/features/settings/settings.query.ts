import { queryOptions } from "@tanstack/react-query";
import { STALE_MS } from "#/config/polling.ts";
import { getPanelEnvHintsFn, listSettingsFn } from "./settings.functions";

export const settingsQueryOptions = queryOptions({
	queryKey: ["settings"],
	queryFn: async () => await listSettingsFn(),
	staleTime: STALE_MS.medium,
});

/** Env lines shown under the panel domain (`domain`: the setting or an example). */
export const panelEnvHintsQueryOptions = (domain: string) =>
	queryOptions({
		queryKey: ["settings", "panel-env", domain],
		queryFn: async () => await getPanelEnvHintsFn({ data: { domain } }),
		staleTime: STALE_MS.static,
	});
