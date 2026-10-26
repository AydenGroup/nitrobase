import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { deliveryReasonLabels } from "#/config/git-delivery-reasons.ts";
import { lookup } from "#/config/labels.ts";
import type { DetectionReason, GitAuthKind } from "#/features/git/schema.ts";

/** Repository authentication choices (wizard + Source settings). */
export const gitAuthLabels = {
	none: msg({ id: "Public repository" }),
	deploy_key: msg({ id: "Deploy key (SSH)" }),
	token: msg({ id: "Access token (HTTPS)" }),
} satisfies Record<GitAuthKind, MessageDescriptor>;

/** Why a builder was detected. */
export function detectionReasonText(
	i18n: I18n,
	reason: DetectionReason,
): string {
	switch (reason.code) {
		case "dockerfile":
			return i18n._("Found {path}", { path: reason.path });
		case "static_framework":
			return i18n._("{framework} project with a build script", {
				framework: reason.framework,
			});
		case "static_html":
			return i18n._("index.html without a package.json");
		case "railpack":
			return i18n._("Found {file}", { file: reason.marker });
		default:
			return i18n._(
				"Nothing recognised: choose a builder, or add a Dockerfile to the repository.",
			);
	}
}

export function deliveryReasonText(
	i18n: I18n,
	reason: string | null,
): string | null {
	if (!reason) return null;
	const label = lookup(deliveryReasonLabels, reason);
	return label ? i18n._(label) : reason;
}
