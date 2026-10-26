import nodemailer from "nodemailer";
import {
	type DiscordConfig,
	type EmailConfig,
	getChannelDriver,
	type SlackConfig,
	type TelegramConfig,
	type WebhookConfig,
} from "#/config/notification-channels.ts";
import { TELEGRAM_DEFAULT_API_URL } from "#/config/server.ts";
import { assertHttpOk, postJson, resolvePublic } from "./http";
import { DeliveryError, type NotificationMessage } from "./message";
import {
	buildDiscordRequest,
	buildEmail,
	buildSlackRequest,
	buildTelegramRequest,
	buildWebhookRequest,
	type HttpRequestSpec,
} from "./payloads";

export interface SendContext {
	timeoutMs: number;
	telegramApiUrl: string;
	now: Date;
}

type Sender = (
	config: Record<string, unknown>,
	message: NotificationMessage,
	ctx: SendContext,
) => Promise<void>;

async function sendHttp(
	spec: HttpRequestSpec,
	allowPrivate: boolean,
	ctx: SendContext,
): Promise<void> {
	const response = await postJson(spec, {
		allowPrivate,
		timeoutMs: ctx.timeoutMs,
	});
	assertHttpOk(response.status, response.body);
}

/**
 * Email over SMTP with nodemailer: STARTTLS/TLS, AUTH, address and header
 * encoding are easy to get subtly wrong, so a maintained client is used
 * instead of a hand-written one. The SMTP host is resolved and checked
 * like webhook hosts, and the connection goes to that address.
 */
const sendEmail: Sender = async (raw, message, ctx) => {
	const config = raw as EmailConfig;
	const pinned = await resolvePublic(config.host, config.privateNetwork);
	const transport = nodemailer.createTransport({
		host: pinned.address,
		port: config.port,
		secure: config.security === "tls",
		requireTLS: config.security === "starttls",
		ignoreTLS: config.security === "none",
		// Certificates are checked against the configured name, not the IP.
		tls: { servername: config.host },
		auth: config.username
			? { user: config.username, pass: config.password }
			: undefined,
		connectionTimeout: ctx.timeoutMs,
		greetingTimeout: ctx.timeoutMs,
		socketTimeout: ctx.timeoutMs,
	});
	try {
		await transport.sendMail(buildEmail(config, message));
	} catch (error) {
		const err = error as {
			code?: string;
			responseCode?: number;
			command?: string;
			message?: string;
		};
		if (err.code === "EAUTH") {
			throw new DeliveryError("auth", "SMTP authentication failed", false);
		}
		if (err.responseCode && err.responseCode >= 400) {
			// e.g. "SMTP 502 on STARTTLS": the server does not offer STARTTLS.
			const on = err.command ? ` on ${err.command.split(" ")[0]}` : "";
			throw new DeliveryError(
				"smtp",
				`SMTP ${err.responseCode}${on}`,
				err.responseCode < 500,
			);
		}
		throw new DeliveryError(
			err.code === "ETIMEDOUT" ? "timeout" : "network",
			err.code ?? "SMTP error",
			true,
		);
	} finally {
		transport.close();
	}
};

const channelSenders: Record<string, Sender> = {
	email: sendEmail,
	discord: (raw, message, ctx) => {
		const config = raw as DiscordConfig;
		return sendHttp(
			buildDiscordRequest(config, message),
			config.privateNetwork,
			ctx,
		);
	},
	slack: (raw, message, ctx) => {
		const config = raw as SlackConfig;
		return sendHttp(
			buildSlackRequest(config, message),
			config.privateNetwork,
			ctx,
		);
	},
	telegram: async (raw, message, ctx) => {
		// The Bot API base comes from config (trusted), not from the user.
		const spec = buildTelegramRequest(
			raw as TelegramConfig,
			message,
			ctx.telegramApiUrl,
		);
		await sendHttp(spec, isLocalOverride(new URL(ctx.telegramApiUrl)), ctx);
	},
	webhook: (raw, message, ctx) => {
		const config = raw as WebhookConfig;
		return sendHttp(
			buildWebhookRequest(config, message, ctx.now),
			config.privateNetwork,
			ctx,
		);
	},
};

/** TELEGRAM_API_URL pointed at a private host (tests, proxies). */
function isLocalOverride(base: URL): boolean {
	return base.origin !== new URL(TELEGRAM_DEFAULT_API_URL).origin;
}

export async function sendThroughChannel(
	type: string,
	config: Record<string, unknown>,
	message: NotificationMessage,
	ctx: SendContext,
): Promise<void> {
	const sender = channelSenders[type];
	if (!sender || !getChannelDriver(type)) {
		throw new DeliveryError("unknown", `unknown channel type ${type}`, false);
	}
	await sender(config, message, ctx);
}
