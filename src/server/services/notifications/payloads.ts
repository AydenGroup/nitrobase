import { createHmac } from "node:crypto";
import { WEBHOOK_HEADERS } from "#/config/identifiers.ts";
import type {
	DiscordConfig,
	EmailConfig,
	SlackConfig,
	TelegramConfig,
	WebhookConfig,
} from "#/config/notification-channels.ts";
import { APP_NAME } from "#/config/shared.ts";
import { notificationSeverityColors } from "#/theme/tokens.ts";
import type { NotificationMessage } from "./message";

/**
 * Exact request shapes per channel. Pure: no I/O, no secrets in anything
 * but the URL/headers the service itself requires.
 */

export interface HttpRequestSpec {
	url: string;
	headers: Record<string, string>;
	body: string;
}

const SEVERITY_COLORS = notificationSeverityColors;

const JSON_HEADERS = { "content-type": "application/json" };

const DISCORD_LIMITS = { title: 256, description: 4096 };
const SLACK_TEXT_LIMIT = 3000;
const TELEGRAM_LIMIT = 4096;

const cut = (text: string, max: number) =>
	text.length > max ? `${text.slice(0, max - 1)}…` : text;

export function buildDiscordRequest(
	config: Pick<DiscordConfig, "webhookUrl">,
	message: NotificationMessage,
): HttpRequestSpec {
	return {
		url: config.webhookUrl,
		headers: JSON_HEADERS,
		body: JSON.stringify({
			username: APP_NAME,
			allowed_mentions: { parse: [] },
			embeds: [
				{
					title: cut(message.title, DISCORD_LIMITS.title),
					description: cut(message.body, DISCORD_LIMITS.description),
					color: SEVERITY_COLORS[message.severity],
					timestamp: message.at.toISOString(),
					...(message.url ? { url: message.url } : {}),
					fields: message.fields.map((item) => ({
						name: cut(item.label, 256),
						value: cut(item.value, 1024),
						inline: true,
					})),
					footer: { text: message.eventId },
				},
			],
		}),
	};
}

export function buildSlackRequest(
	config: Pick<SlackConfig, "webhookUrl">,
	message: NotificationMessage,
): HttpRequestSpec {
	const color = `#${SEVERITY_COLORS[message.severity].toString(16).padStart(6, "0")}`;
	return {
		url: config.webhookUrl,
		headers: JSON_HEADERS,
		body: JSON.stringify({
			text: cut(message.title, SLACK_TEXT_LIMIT),
			attachments: [
				{
					color,
					blocks: [
						{
							type: "section",
							text: {
								type: "mrkdwn",
								text: cut(message.body, SLACK_TEXT_LIMIT),
							},
						},
						...(message.fields.length
							? [
									{
										type: "section",
										fields: message.fields.slice(0, 10).map((item) => ({
											type: "mrkdwn",
											text: `*${item.label}*\n${item.value}`,
										})),
									},
								]
							: []),
						{
							type: "context",
							elements: [
								{
									type: "mrkdwn",
									text: message.url
										? `<${message.url}|${message.eventId}>`
										: message.eventId,
								},
							],
						},
					],
				},
			],
		}),
	};
}

const escapeHtml = (text: string) =>
	text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function buildTelegramRequest(
	config: TelegramConfig,
	message: NotificationMessage,
	apiBase: string,
): HttpRequestSpec {
	const lines = [
		`<b>${escapeHtml(message.title)}</b>`,
		escapeHtml(message.body),
		...message.fields.map(
			(item) => `<i>${escapeHtml(item.label)}:</i> ${escapeHtml(item.value)}`,
		),
		...(message.url ? [escapeHtml(message.url)] : []),
	];
	return {
		url: `${apiBase.replace(/\/$/, "")}/bot${config.botToken}/sendMessage`,
		headers: JSON_HEADERS,
		body: JSON.stringify({
			chat_id: config.chatId,
			text: cut(lines.join("\n"), TELEGRAM_LIMIT),
			parse_mode: "HTML",
			disable_web_page_preview: true,
		}),
	};
}

const SIGNATURE_HEADER = WEBHOOK_HEADERS.signature;
const TIMESTAMP_HEADER = WEBHOOK_HEADERS.timestamp;
const EVENT_HEADER = WEBHOOK_HEADERS.event;

/** `sha256=<hex HMAC-SHA256(secret, "<timestamp>.<body>")>`. */
export function signWebhook(
	secret: string,
	timestamp: string,
	body: string,
): string {
	const digest = createHmac("sha256", secret)
		.update(`${timestamp}.${body}`)
		.digest("hex");
	return `sha256=${digest}`;
}

function webhookPayload(message: NotificationMessage) {
	return {
		event: message.eventId,
		severity: message.severity,
		title: message.title,
		body: message.body,
		url: message.url,
		at: message.at.toISOString(),
		fields: Object.fromEntries(
			message.fields.map((item) => [item.label, item.value]),
		),
	};
}

export function buildWebhookRequest(
	config: Pick<WebhookConfig, "url" | "signingSecret">,
	message: NotificationMessage,
	now: Date,
): HttpRequestSpec {
	const body = JSON.stringify(webhookPayload(message));
	const timestamp = String(Math.floor(now.getTime() / 1000));
	return {
		url: config.url,
		headers: {
			...JSON_HEADERS,
			"user-agent": `${APP_NAME}-Webhook`,
			[EVENT_HEADER]: message.eventId,
			[TIMESTAMP_HEADER]: timestamp,
			[SIGNATURE_HEADER]: signWebhook(config.signingSecret, timestamp, body),
		},
		body,
	};
}

export interface EmailSpec {
	from: string;
	to: string[];
	subject: string;
	text: string;
}

export function buildEmail(
	config: Pick<EmailConfig, "from" | "to">,
	message: NotificationMessage,
): EmailSpec {
	const text = [
		message.body,
		"",
		...message.fields.map((item) => `${item.label}: ${item.value}`),
		...(message.url ? ["", message.url] : []),
		"",
		`— ${APP_NAME} (${message.eventId}, ${message.at.toISOString()})`,
	].join("\n");
	return {
		from: config.from,
		to: config.to
			.split(",")
			.map((item) => item.trim())
			.filter(Boolean),
		subject: `[${APP_NAME}] ${message.title}`.replace(/[\r\n]+/g, " "),
		text,
	};
}
