import { queryOptions } from "@tanstack/react-query";
import { STALE_MS } from "#/config/polling.ts";
import {
	getTemplateVersionsFn,
	listTemplateProblemsFn,
	listTemplatesFn,
} from "./templates.functions";

export const templatesQueryOptions = queryOptions({
	queryKey: ["templates"],
	queryFn: async () => await listTemplatesFn(),
	staleTime: STALE_MS.static,
});

export const templateVersionsQueryOptions = (
	templateId: string,
	includePrereleases = false,
) =>
	queryOptions({
		queryKey: ["templates", templateId, "versions", includePrereleases],
		queryFn: async () =>
			await getTemplateVersionsFn({ data: { templateId, includePrereleases } }),
		staleTime: STALE_MS.static,
	});

export const templateProblemsQueryOptions = queryOptions({
	queryKey: ["templates", "problems"],
	queryFn: async () => await listTemplateProblemsFn(),
	staleTime: STALE_MS.long,
});
