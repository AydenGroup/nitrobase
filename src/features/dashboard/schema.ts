import type { OnboardingStepId } from "#/config/onboarding.ts";
import type { DomainCheckResultRecord } from "#/db/schema/apps.ts";
import type { AppStatus, DomainCheckStatus } from "#/features/apps/schema.ts";
import type { JobListItem } from "#/features/deployments/schema.ts";
import type {
	AlertDTO,
	ServerHealthSummary,
} from "#/features/monitoring/schema.ts";
import type { ServerStatus } from "#/features/servers/schema.ts";

export interface DashboardData {
	/** "Install on a VPS" guide linked from the checklist. */
	installGuideUrl: string;
	/** First-run checklist: step id -> done. */
	onboarding: Record<OnboardingStepId, boolean>;
	servers: {
		id: string;
		name: string;
		host: string;
		status: ServerStatus;
		isDefault: boolean;
		dockerVersion: string | null;
		lastError: string | null;
	}[];
	serverHealth: ServerHealthSummary[];
	openAlerts: AlertDTO[];
	/** Config ALERT_DISK_PERCENT (banner wording). */
	diskAlertPercent: number;
	serversByStatus: Partial<Record<ServerStatus, number>>;
	/** Apps other than databases. */
	appsByStatus: Partial<Record<AppStatus, number>>;
	appCount: number;
	databasesByStatus: Partial<Record<AppStatus, number>>;
	databaseCount: number;
	domainCount: number;
	/** Domains by their worst DNS/certificate check (`unknown`: not checked). */
	domainsByCheck: Partial<Record<DomainCheckStatus, number>>;
	jobsRunning: number;
	jobsFailed24h: number;
	jobsSucceeded24h: number;
	recentJobs: JobListItem[];
	domainIssues: {
		id: string;
		host: string;
		appId: string;
		appName: string;
		checks: Record<string, DomainCheckResultRecord>;
	}[];
}
