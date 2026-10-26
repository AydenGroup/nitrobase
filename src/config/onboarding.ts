import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import {
	AppWindow,
	BellRing,
	CalendarClock,
	CloudUpload,
	Globe,
	type LucideIcon,
	Server,
	ShieldCheck,
} from "lucide-react";
import { branded } from "#/libs/brand.ts";
import type { Permission } from "./permissions";

/**
 * First-run checklist on the dashboard (client-safe registry). The server
 * computes each step's completion from real state (`getOnboarding`); a
 * step is shown only when the viewer may act on it. Adding a step = one
 * entry here + its check in `dashboard.server.ts` (keyed by id, so a
 * missing check is a compile error).
 */
const onboardingStepIds = [
	"server",
	"app",
	"offsite",
	"schedule",
	"notifications",
	"twoFactor",
	"panelDomain",
] as const;

export type OnboardingStepId = (typeof onboardingStepIds)[number];

export interface OnboardingStep {
	id: OnboardingStepId;
	label: MessageDescriptor;
	description: MessageDescriptor;
	action: MessageDescriptor;
	icon: LucideIcon;
	/** Path without locale prefix. */
	to: string;
	search?: Record<string, string>;
	/** Shown only when the viewer may do it. */
	permission?: Permission;
}

export const onboardingSteps: OnboardingStep[] = [
	{
		id: "server",
		label: msg({ id: "Get a server ready" }),
		description: msg({
			id: "Add a VPS over SSH (or use this machine) and bootstrap it: Docker and Traefik are installed for you.",
		}),
		action: msg({ id: "Servers" }),
		icon: Server,
		to: "/servers",
		permission: "server.manage",
	},
	{
		id: "app",
		label: msg({ id: "Deploy your first app" }),
		description: msg({
			id: "Pick a template from the marketplace; a free domain with HTTPS is set up automatically.",
		}),
		action: msg({ id: "New app" }),
		icon: AppWindow,
		to: "/apps/new",
		permission: "app.deploy",
	},
	{
		id: "offsite",
		label: msg({ id: "Add an off-site backup destination" }),
		description: msg({
			id: "S3, R2 or B2 keep copies away from the server, so a lost server does not take the backups with it.",
		}),
		action: msg({ id: "Destinations" }),
		icon: CloudUpload,
		to: "/destinations",
		permission: "destination.manage",
	},
	{
		id: "schedule",
		label: msg({ id: "Schedule backups for an app" }),
		description: msg({
			id: "Open an app's Backups tab and choose daily or weekly backups with a retention.",
		}),
		action: msg({ id: "Apps" }),
		icon: CalendarClock,
		to: "/apps",
		permission: "backup.policy.manage",
	},
	{
		id: "notifications",
		label: msg({ id: "Get notified when something fails" }),
		description: msg({
			id: "Email, Slack, Discord, Telegram or a webhook for failed jobs, alerts and expiring certificates.",
		}),
		action: msg({ id: "Notifications" }),
		icon: BellRing,
		to: "/settings/notifications",
		permission: "notification.manage",
	},
	{
		id: "twoFactor",
		label: msg({ id: "Turn on two-factor authentication" }),
		description: msg({
			id: "This panel holds the keys to your servers: protect your account with an authenticator app.",
		}),
		action: msg({ id: "Security" }),
		icon: ShieldCheck,
		to: "/settings/security",
	},
	{
		id: "panelDomain",
		label: msg({ id: "Serve the panel over HTTPS" }),
		description: branded(
			msg({
				id: "Give {appName} its own domain with a Let's Encrypt certificate instead of a plain IP and port.",
			}),
		),
		action: msg({ id: "Instance settings" }),
		icon: Globe,
		to: "/settings/instance",
		permission: "instance.manage",
	},
];
