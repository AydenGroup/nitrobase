import { z } from "zod";
import { DEPLOYMENT_STATUSES } from "#/config/enums.ts";
import type { DeploymentStatus } from "#/features/servers/schema.ts";
import type { CodedParams } from "#/libs/coded.ts";

export const JobFiltersSchema = z.object({
	type: z
		.string()
		.regex(/^[a-z_]+$/)
		.optional(),
	status: z.enum(DEPLOYMENT_STATUSES).optional(),
	serverId: z.guid().optional(),
	appId: z.guid().optional(),
	limit: z.number().int().min(1).max(200).default(100),
});

export type JobFilters = z.infer<typeof JobFiltersSchema>;

export interface JobListItem {
	id: string;
	type: string;
	/** Source-language title (API clients); the UI renders the coded one. */
	title: string;
	titleKey: string | null;
	titleParams: CodedParams;
	status: DeploymentStatus;
	/** Source-language text or raw output; coded errors use the next two. */
	errorMessage: string | null;
	errorCode: string | null;
	errorParams: CodedParams | null;
	/** Problems the job tolerated (success with warnings). */
	warningCount: number;
	serverId: string;
	serverName: string | null;
	appId: string | null;
	appName: string | null;
	createdAt: Date;
	updatedAt: Date;
}
