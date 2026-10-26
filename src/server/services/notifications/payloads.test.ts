import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { APP_NAME } from "#/config/shared.ts";
import type { NotificationMessage } from "./message";
import {
	buildDiscordRequest,
	buildEmail,
	buildSlackRequest,
	buildTelegramRequest,
	buildWebhookRequest,
	signWebhook,
} from "./payloads";

const message: NotificationMessage = {
	eventId: "alert.opened",
	severity: "warning",
	title: "Alert: Disk almost full on devbox",
	body: "Disk almost full: / (value 91, threshold 85).",
	url: "https://panel.example.com/servers/s1",
	at: new Date("2026-10-05T12:00:00Z"),
	fields: [{ label: "Server", value: "devbox" }],
};

describe("channel payloads", () => {
	it("Discord: one embed, no mentions", () => {
		const spec = buildDiscordRequest(
			{ webhookUrl: "https://discord.com/api/webhooks/1/abc" },
			message,
		);
		expect(spec.url).toBe("https://discord.com/api/webhooks/1/abc");
		expect(spec.headers).toEqual({ "content-type": "application/json" });
		expect(JSON.parse(spec.body)).toEqual({
			username: APP_NAME,
			allowed_mentions: { parse: [] },
			embeds: [
				{
					title: "Alert: Disk almost full on devbox",
					description: "Disk almost full: / (value 91, threshold 85).",
					color: 0xf59f00,
					timestamp: "2026-10-05T12:00:00.000Z",
					url: "https://panel.example.com/servers/s1",
					fields: [{ name: "Server", value: "devbox", inline: true }],
					footer: { text: "alert.opened" },
				},
			],
		});
	});

	it("Slack: text + colored attachment with blocks", () => {
		const spec = buildSlackRequest(
			{ webhookUrl: "https://hooks.slack.com/services/T/B/x" },
			message,
		);
		expect(JSON.parse(spec.body)).toEqual({
			text: "Alert: Disk almost full on devbox",
			attachments: [
				{
					color: "#f59f00",
					blocks: [
						{
							type: "section",
							text: {
								type: "mrkdwn",
								text: "Disk almost full: / (value 91, threshold 85).",
							},
						},
						{
							type: "section",
							fields: [{ type: "mrkdwn", text: "*Server*\ndevbox" }],
						},
						{
							type: "context",
							elements: [
								{
									type: "mrkdwn",
									text: "<https://panel.example.com/servers/s1|alert.opened>",
								},
							],
						},
					],
				},
			],
		});
	});

	it("Telegram: sendMessage with escaped HTML, token only in the path", () => {
		const spec = buildTelegramRequest(
			{ botToken: "123456:ABCDEFGHIJKLMNOPQRSTUVWX", chatId: "-1001" },
			{ ...message, body: "a <b> & c" },
			"https://api.telegram.org/",
		);
		expect(spec.url).toBe(
			"https://api.telegram.org/bot123456:ABCDEFGHIJKLMNOPQRSTUVWX/sendMessage",
		);
		expect(JSON.parse(spec.body)).toEqual({
			chat_id: "-1001",
			text: [
				"<b>Alert: Disk almost full on devbox</b>",
				"a &lt;b&gt; &amp; c",
				"<i>Server:</i> devbox",
				"https://panel.example.com/servers/s1",
			].join("\n"),
			parse_mode: "HTML",
			disable_web_page_preview: true,
		});
		expect(spec.body).not.toContain("ABCDEFGHIJ");
	});

	it("Webhook: JSON body signed over timestamp.body", () => {
		const secret = "a".repeat(64);
		const spec = buildWebhookRequest(
			{ url: "https://example.com/hook", signingSecret: secret },
			message,
			new Date("2026-10-05T12:00:00Z"),
		);
		expect(JSON.parse(spec.body)).toEqual({
			event: "alert.opened",
			severity: "warning",
			title: "Alert: Disk almost full on devbox",
			body: "Disk almost full: / (value 91, threshold 85).",
			url: "https://panel.example.com/servers/s1",
			at: "2026-10-05T12:00:00.000Z",
			fields: { Server: "devbox" },
		});
		expect(spec.headers["x-nitrobase-timestamp"]).toBe("1791201600");
		expect(spec.headers["x-nitrobase-event"]).toBe("alert.opened");
		expect(spec.headers["user-agent"]).toBe("Nitrobase-Webhook");
		const expected = createHmac("sha256", secret)
			.update(`1791201600.${spec.body}`)
			.digest("hex");
		expect(spec.headers["x-nitrobase-signature"]).toBe(`sha256=${expected}`);
		expect(spec.body).not.toContain(secret);
	});

	it("signWebhook matches a known HMAC vector", () => {
		// HMAC-SHA256("key", "1.{}")
		expect(signWebhook("key", "1", "{}")).toBe(
			`sha256=${createHmac("sha256", "key").update("1.{}").digest("hex")}`,
		);
		expect(signWebhook("key", "1", "{}")).not.toBe(
			signWebhook("key", "2", "{}"),
		);
	});

	it("Email: subject prefix, one line, recipients split", () => {
		const spec = buildEmail(
			{ from: "panel@example.com", to: "a@example.com, b@example.com" },
			{ ...message, title: "line\r\nbreak" },
		);
		expect(spec).toEqual({
			from: "panel@example.com",
			to: ["a@example.com", "b@example.com"],
			subject: `[${APP_NAME}] line break`,
			text: [
				"Disk almost full: / (value 91, threshold 85).",
				"",
				"Server: devbox",
				"",
				"https://panel.example.com/servers/s1",
				"",
				`— ${APP_NAME} (alert.opened, 2026-10-05T12:00:00.000Z)`,
			].join("\n"),
		});
	});
});
