import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { lookup } from "./labels.ts";

/**
 * UI labels for domain checkers (server registry:
 * #/server/services/domains/checkers.ts). Unknown ids render with their id.
 */
type DomainCheckId = "dns" | "tunnel" | "cert";

const domainCheckLabels = {
	dns: msg({ id: "DNS" }),
	tunnel: msg({ id: "Tunnel" }),
	cert: msg({ id: "Certificate" }),
} satisfies Record<DomainCheckId, MessageDescriptor>;

/** Translated label of a checker id; unknown ids render as themselves. */
export function domainCheckLabel(i18n: I18n, id: string): string {
	const label = lookup(domainCheckLabels, id);
	return label ? i18n._(label) : id;
}
