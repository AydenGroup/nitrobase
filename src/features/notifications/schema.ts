import type { I18n } from "@lingui/core";
import { z } from "zod";
import { NAME_MAX_LENGTH } from "#/config/shared.ts";
import type {
	ChannelSubscription,
	ChannelTestRecord,
	notificationChannels,
	notificationDeliveries,
} from "#/db/schema/platform";

export type ChannelRow = typeof notificationChannels.$inferSelect;
type DeliveryRow = typeof notificationDeliveries.$inferSelect;
export type { ChannelSubscription };

const SubscriptionSchema = z.object({
	events: z.array(z.string().regex(/^[a-z0-9_.]+$/)).max(500),
	serverIds: z.array(z.guid()).max(200).default([]),
	appIds: z.array(z.guid()).max(500).default([]),
});

export const ChannelInputSchema = (i18n: I18n) =>
	z.object({
		name: z
			.string()
			.trim()
			.min(1, { message: i18n._("Name is required") })
			.max(NAME_MAX_LENGTH),
		type: z.string().regex(/^[a-z0-9-]+$/),
		/** Driver config; validated by the driver schema on the server. */
		config: z.record(z.string(), z.unknown()),
		enabled: z.boolean().default(true),
		subscription: SubscriptionSchema.optional(),
	});

export const UpdateChannelSchema = (i18n: I18n) =>
	ChannelInputSchema(i18n).extend({ id: z.guid() });

export const ChannelIdSchema = z.object({ id: z.guid() });

export const TestChannelSchema = z.object({
	id: z.guid(),
	/** Catalog event to send as a sample; omitted = generic test message. */
	eventId: z
		.string()
		.regex(/^[a-z0-9_.]+$/)
		.max(100)
		.optional(),
});

export const DeliveryListSchema = z.object({
	channelId: z.guid().optional(),
	limit: z.number().int().min(1).max(200).default(50),
});

export interface ChannelDTO {
	id: string;
	name: string;
	type: string;
	/** Config with secret fields masked. */
	config: Record<string, string | number | boolean | null>;
	enabled: boolean;
	subscription: ChannelSubscription;
	lastTest: ChannelTestRecord | null;
	createdAt: Date;
	updatedAt: Date;
}

export interface DeliveryDTO {
	id: string;
	channelId: string;
	channelName: string;
	eventId: string;
	title: string;
	status: DeliveryRow["status"];
	attempts: number;
	lastError: string | null;
	createdAt: Date;
	sentAt: Date | null;
}
