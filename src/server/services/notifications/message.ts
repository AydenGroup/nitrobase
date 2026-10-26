import type { EventSeverity } from "#/config/notification-events.ts";

/** A rendered notification, ready for any channel. */
export interface NotificationMessage {
	eventId: string;
	severity: EventSeverity;
	title: string;
	body: string;
	/** Panel link to the server/app/page concerned (null without APP_URL). */
	url: string | null;
	at: Date;
	/** Short labelled facts (Server, App...), already translated keys. */
	fields: { label: string; value: string }[];
}

/** Classified send failure (UI label: `deliveryErrorLabels`). */
export class DeliveryError extends Error {
	constructor(
		readonly kind:
			| "blocked"
			| "timeout"
			| "http"
			| "redirect"
			| "smtp"
			| "network"
			| "auth"
			| "unknown",
		message: string,
		/** Worth another attempt (timeouts, 5xx, 429). */
		readonly retryable: boolean,
	) {
		super(message);
		this.name = "DeliveryError";
	}
}
