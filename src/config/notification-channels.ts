import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { z } from "zod";
import { WEBHOOK_HEADERS } from "#/config/identifiers.ts";
import { APP_ID } from "#/config/shared.ts";
import { branded } from "#/libs/brand.ts";
import {
	emailSchema as emailAddress,
	isEmail,
	normalizeEmail,
} from "#/libs/email.ts";
import {
	crossField,
	field,
	isPrivateHost,
	schemaFields,
	validation,
} from "./schema-fields";

/**
 * Notification channel drivers. Adding one = an entry here (zod config
 * schema with form metadata) + a sender in
 * #/server/services/notifications/drivers.ts. Client-safe.
 */
export interface ChannelDriver<S extends z.ZodObject = z.ZodObject> {
	type: string;
	label: MessageDescriptor;
	description: MessageDescriptor;
	schema: S;
	/**
	 * Requests are signed with a generated secret the owner can reveal
	 * (to verify them on the receiving side).
	 */
	signsRequests?: boolean;
}

const privateNetwork = z
	.boolean()
	.default(false)
	.meta(
		field({
			label: msg({ id: "Private network" }),
			help: msg({
				id: "Allow private, loopback or link-local addresses and unencrypted connections (e.g. a relay on your LAN). Off: public hosts over TLS only.",
			}),
		}),
	);

/** No control characters: values end up in headers and URLs. */
const line = z
	.string()
	.trim()
	.min(1)
	.max(512)
	.refine(
		(value) => !/[\r\n\0]/.test(value),
		validation(msg({ id: "Single line only" })),
	);

const httpsUrl = z.url().max(2048);

/** https to a public host unless `privateNetwork` (SSRF guard). */
function publicUrlRule(key: string) {
	return (config: Record<string, unknown>, ctx: z.RefinementCtx) => {
		if (config.privateNetwork) return;
		const value = config[key];
		if (typeof value !== "string") return;
		let url: URL;
		try {
			url = new URL(value);
		} catch {
			return;
		}
		if (url.protocol !== "https:" || isPrivateHost(url.hostname)) {
			ctx.addIssue({
				code: "custom",
				path: [key],
				message: validation(
					msg({ id: "Use https to a public host, or enable private network" }),
				),
			});
		}
	};
}

/** Comma-separated addresses, each normalized (`normalizeEmail`). */
const emailList = z
	.string()
	.trim()
	.min(3)
	.max(1000)
	.refine(
		(value) => value.split(",").every((item) => isEmail(item)),
		validation(msg({ id: "Comma-separated email addresses" })),
	)
	.transform((value) =>
		value
			.split(",")
			.map((item) => normalizeEmail(item))
			.join(", "),
	);

const emailSchema = z
	.object({
		host: line.meta(
			field({
				label: msg({ id: "SMTP host" }),
				placeholder: "smtp.example.com",
			}),
		),
		port: z.coerce
			.number()
			.int()
			.min(1)
			.max(65535)
			.default(587)
			.meta(field({ label: msg({ id: "Port" }) })),
		security: z
			.enum(["starttls", "tls", "none"])
			.default("starttls")
			.meta(
				field({
					label: msg({ id: "Encryption" }),
					options: [
						{ value: "starttls", label: msg({ id: "STARTTLS (port 587)" }) },
						{ value: "tls", label: msg({ id: "TLS (port 465)" }) },
						{
							value: "none",
							label: msg({ id: "None (private network only)" }),
						},
					],
				}),
			),
		username: z
			.string()
			.trim()
			.max(256)
			.default("")
			.meta(field({ label: msg({ id: "Username" }) })),
		password: z
			.string()
			.max(512)
			.default("")
			.meta(field({ label: msg({ id: "Password" }), secret: true })),
		from: emailAddress().meta(
			field({
				label: msg({ id: "From address" }),
				placeholder: `${APP_ID}@example.com`,
			}),
		),
		to: emailList.meta(
			field({
				label: msg({ id: "Recipients" }),
				help: msg({ id: "Comma-separated email addresses." }),
			}),
		),
		privateNetwork,
	})
	.superRefine((config, ctx) => {
		if (config.privateNetwork) return;
		if (config.security === "none") {
			ctx.addIssue({
				code: "custom",
				path: ["security"],
				message: validation(
					msg({ id: "Unencrypted SMTP needs private network" }),
				),
			});
		}
		if (typeof config.host === "string" && isPrivateHost(config.host)) {
			ctx.addIssue({
				code: "custom",
				path: ["host"],
				message: validation(
					msg({ id: "A private host needs private network" }),
				),
			});
		}
	}, crossField);

const discordSchema = z
	.object({
		webhookUrl: httpsUrl.meta(
			field({
				label: msg({ id: "Webhook URL" }),
				help: msg({
					id: "Channel settings → Integrations → Webhooks → Copy webhook URL.",
				}),
				secret: true,
			}),
		),
		privateNetwork,
	})
	.superRefine(publicUrlRule("webhookUrl"), crossField);

const slackSchema = z
	.object({
		webhookUrl: httpsUrl.meta(
			field({
				label: msg({ id: "Webhook URL" }),
				help: msg({ id: "An Incoming Webhook URL of your Slack app." }),
				secret: true,
			}),
		),
		privateNetwork,
	})
	.superRefine(publicUrlRule("webhookUrl"), crossField);

const telegramSchema = z.object({
	botToken: z
		.string()
		.trim()
		.regex(
			/^\d{3,20}:[A-Za-z0-9_-]{20,100}$/,
			validation(msg({ id: "The token from @BotFather" })),
		)
		.meta(
			field({
				label: msg({ id: "Bot token" }),
				help: msg({ id: "From @BotFather (123456:ABC-...)." }),
				secret: true,
			}),
		),
	chatId: z
		.string()
		.trim()
		.regex(
			/^(-?\d{1,20}|@[A-Za-z0-9_]{5,64})$/,
			validation(msg({ id: "A numeric chat id or @channel" })),
		)
		.meta(
			field({
				label: msg({ id: "Chat ID" }),
				help: msg({
					id: "A user/group id (e.g. -1001234567890) or @channelname. The bot must be a member.",
				}),
			}),
		),
});

const webhookSchema = z
	.object({
		url: httpsUrl.meta(
			field({
				label: msg({ id: "URL" }),
				placeholder: `https://example.com/hooks/${APP_ID}`,
				help: {
					...msg({
						id: "Receives a JSON POST signed with HMAC-SHA256 (header {signatureHeader}).",
					}),
					values: { signatureHeader: WEBHOOK_HEADERS.signature },
				},
			}),
		),
		signingSecret: z
			.string()
			.regex(/^[a-f0-9]{64}$/)
			.meta(
				field({
					label: msg({ id: "Signing secret" }),
					secret: true,
					generated: true,
				}),
			),
		privateNetwork,
	})
	.superRefine(publicUrlRule("url"), crossField);

export const channelDrivers: ChannelDriver[] = [
	{
		type: "email",
		label: msg({ id: "Email (SMTP)" }),
		description: msg({ id: "Send through any SMTP server." }),
		schema: emailSchema,
	},
	{
		type: "discord",
		label: msg({ id: "Discord" }),
		description: msg({ id: "Post to a Discord channel webhook." }),
		schema: discordSchema,
	},
	{
		type: "slack",
		label: msg({ id: "Slack" }),
		description: msg({ id: "Post to a Slack Incoming Webhook." }),
		schema: slackSchema,
	},
	{
		type: "telegram",
		label: msg({ id: "Telegram" }),
		description: msg({ id: "Message a chat through your Telegram bot." }),
		schema: telegramSchema,
	},
	{
		type: "webhook",
		signsRequests: true,
		label: msg({ id: "Webhook" }),
		description: msg({
			id: "A signed JSON POST to your own endpoint (automation, chat bridges).",
		}),
		schema: webhookSchema,
	},
];

export type EmailConfig = z.infer<typeof emailSchema>;
export type DiscordConfig = z.infer<typeof discordSchema>;
export type SlackConfig = z.infer<typeof slackSchema>;
export type TelegramConfig = z.infer<typeof telegramSchema>;
export type WebhookConfig = z.infer<typeof webhookSchema>;

export function getChannelDriver(type: string): ChannelDriver | null {
	return channelDrivers.find((driver) => driver.type === type) ?? null;
}

/** Form fields (generated ones are not typed by the user). */
export function channelFields(driver: ChannelDriver) {
	return schemaFields(driver.schema);
}

/** Channel test / delivery failure labels. */
const deliveryErrorLabels: Record<string, MessageDescriptor> = {
	blocked: msg({
		id: "The address resolves to a private network: enable private network on the channel if that is intended.",
	}),
	timeout: msg({ id: "The endpoint did not answer in time." }),
	http: msg({ id: "The endpoint answered with an error." }),
	redirect: msg({
		id: "The endpoint answered with a redirect, which is not followed: use the final URL.",
	}),
	smtp: msg({
		id: "The mail server refused the message (check the security mode, sender and recipients).",
	}),
	network: msg({ id: "Could not connect to the endpoint." }),
	auth: msg({ id: "The service rejected the credentials." }),
	unknown: msg({ id: "Sending failed." }),
	interrupted: branded(
		msg({ id: "Not sent: {appName} restarted before the delivery." }),
	),
};

/**
 * A stored delivery error (`<kind>: <detail>`) for people: the kind's
 * label plus the technical detail (status code, SMTP command).
 */
export function describeDeliveryError(
	i18n: I18n,
	error: string | null | undefined,
): string {
	if (!error) return i18n._(deliveryErrorLabels.unknown);
	const index = error.indexOf(":");
	const kind = index === -1 ? error : error.slice(0, index);
	const detail = index === -1 ? "" : error.slice(index + 1).trim();
	const label = i18n._(
		deliveryErrorLabels[kind] ?? deliveryErrorLabels.unknown,
	);
	return detail ? `${label} (${detail})` : label;
}
