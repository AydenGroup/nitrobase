import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import type {
	AppUpdateKind,
	AppUpdatePolicy,
	AppUpdateResult,
	BatchItemStatus,
	RollbackMode,
} from "#/features/app-updates/schema.ts";

/** Labels of app update states (R4 M4), shared by the update views. */
export const updateKindLabels = {
	major: msg({ id: "major" }),
	minor: msg({ id: "minor" }),
	patch: msg({ id: "patch" }),
	prerelease: msg({ id: "pre-release" }),
	commit: msg({ id: "new commit" }),
	unknown: msg({ id: "newer" }),
} satisfies Record<AppUpdateKind, MessageDescriptor>;

export const updatePolicyLabels = {
	notify: msg({ id: "Notify only" }),
	patch: msg({ id: "Apply patch releases automatically" }),
	minor: msg({ id: "Apply patch and minor releases automatically" }),
} satisfies Record<AppUpdatePolicy, MessageDescriptor>;

export const rollbackLabels = {
	redeploy: msg({
		id: "If the update fails, the previous version is deployed again.",
	}),
	restore: msg({
		id: "If the update fails, the backup taken first is restored (this app's updates change data irreversibly).",
	}),
	manual: msg({
		id: "If the update fails, nothing is rolled back automatically: fix it or restore a backup.",
	}),
} satisfies Record<RollbackMode, MessageDescriptor>;

export const updateResultLabels = {
	queued: msg({ id: "Queued" }),
	running: msg({ id: "Running" }),
	succeeded: msg({ id: "Updated" }),
	rolled_back: msg({ id: "Rolled back" }),
	failed: msg({ id: "Failed" }),
	skipped: msg({ id: "Skipped" }),
} satisfies Record<BatchItemStatus, MessageDescriptor>;

export const updateResultColors: Record<
	AppUpdateResult | BatchItemStatus,
	string
> = {
	queued: "gray",
	running: "blue",
	succeeded: "green",
	rolled_back: "orange",
	failed: "red",
	skipped: "gray",
};
