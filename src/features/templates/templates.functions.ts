import { createServerFn } from "@tanstack/react-start";
import { requirePermission } from "#/features/auth/permissionMiddleware";
import { TemplateVersionsInputSchema } from "./schema";
import {
	getTemplateVersions,
	listTemplateProblems,
	listTemplates,
} from "./templates.server";

export const listTemplatesFn = createServerFn({ method: "GET" })
	.middleware([requirePermission("app.view")])
	.handler(async () => listTemplates());

/** Template folders that failed to load, with the validation message. */
export const listTemplateProblemsFn = createServerFn({ method: "GET" })
	.middleware([requirePermission("instance.manage")])
	.handler(async () => listTemplateProblems());

export const getTemplateVersionsFn = createServerFn({ method: "GET" })
	.validator((data: unknown) => TemplateVersionsInputSchema.parse(data))
	.middleware([requirePermission("app.view")])
	.handler(async ({ data }) =>
		getTemplateVersions(data.templateId, {
			includePrereleases: data.includePrereleases,
			refresh: data.refresh,
		}),
	);
