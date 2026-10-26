import { createServerFn } from "@tanstack/react-start";
import { requirePermission } from "#/features/auth/permissionMiddleware";
import { i18nMiddleware } from "#/libs/i18n.ts";
import {
	createChannel,
	deleteChannel,
	listChannels,
	listDeliveries,
	revealSigningSecret,
	testChannel,
	updateChannel,
} from "./channels.server";
import {
	ChannelIdSchema,
	ChannelInputSchema,
	DeliveryListSchema,
	TestChannelSchema,
	UpdateChannelSchema,
} from "./schema";

// Channel configs never leave the server unmasked (secrets come back as ****).

export const listChannelsFn = createServerFn({ method: "GET" })
	.middleware([requirePermission("notification.manage")])
	.handler(async ({ context }) => listChannels(context.actor));

export const createChannelFn = createServerFn({ method: "POST" })
	.validator((data) => data)
	.middleware([i18nMiddleware, requirePermission("notification.manage")])
	.handler(async ({ context, data }) =>
		createChannel(context.actor, ChannelInputSchema(context.i18n).parse(data)),
	);

export const updateChannelFn = createServerFn({ method: "POST" })
	.validator((data) => data)
	.middleware([i18nMiddleware, requirePermission("notification.manage")])
	.handler(async ({ context, data }) => {
		await updateChannel(
			context.actor,
			UpdateChannelSchema(context.i18n).parse(data),
		);
		return { success: true };
	});

export const deleteChannelFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => ChannelIdSchema.parse(data))
	.middleware([requirePermission("notification.manage")])
	.handler(async ({ context, data }) => {
		await deleteChannel(context.actor, data.id);
		return { success: true };
	});

export const testChannelFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => TestChannelSchema.parse(data))
	.middleware([requirePermission("notification.manage")])
	.handler(async ({ context, data }) =>
		testChannel(context.actor, data.id, data.eventId),
	);

/** Webhook signing secret (explicit reveal, audited). */
export const revealSigningSecretFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => ChannelIdSchema.parse(data))
	.middleware([requirePermission("notification.manage")])
	.handler(async ({ context, data }) =>
		revealSigningSecret(context.actor, data.id),
	);

export const listDeliveriesFn = createServerFn({ method: "GET" })
	.validator((data: unknown) => DeliveryListSchema.parse(data ?? {}))
	.middleware([requirePermission("notification.manage")])
	.handler(async ({ context, data }) => listDeliveries(context.actor, data));
