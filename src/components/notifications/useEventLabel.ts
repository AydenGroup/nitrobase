import { useLingui } from "@lingui/react";
import { getEventDefinition } from "#/config/notification-events.ts";
import { jobTypeLabel } from "#/config/status.ts";

/** Short human label of a catalog event id (job types translated). */
export function useEventLabel() {
	const { i18n } = useLingui();
	return (id: string): string => {
		const definition = getEventDefinition(id);
		if (!definition) return id;
		const values = Object.fromEntries(
			Object.entries(definition.labelValues ?? {}).map(([key, value]) => [
				key,
				key === "job" ? (jobTypeLabel(i18n, value) ?? value) : value,
			]),
		);
		return i18n._({ ...definition.label, values });
	};
}
