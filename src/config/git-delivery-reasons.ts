import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

/** Reasons stored with webhook deliveries. */
export const deliveryReasonLabels = {
	disabled: msg({ id: "Webhook turned off" }),
	event: msg({ id: "Not a push event" }),
	payload: msg({ id: "Unreadable payload" }),
	branch: msg({ id: "Another branch" }),
	deleted: msg({ id: "Branch deleted" }),
	replay: msg({ id: "Delivery already received" }),
	newer_push: msg({ id: "A newer push replaced it" }),
	app_stopped: msg({ id: "App is stopped: built, not deployed" }),
	server_busy: msg({ id: "The server stayed busy" }),
	missing_signature: msg({ id: "Missing signature" }),
	bad_signature: msg({ id: "Wrong signature" }),
	stale: msg({ id: "Timestamp outside the allowed window" }),
	error: msg({ id: "Could not start the build" }),
} satisfies Record<string, MessageDescriptor>;
