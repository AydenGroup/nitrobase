import { setupI18n } from "@lingui/core";
import { describe, expect, it, vi } from "vitest";
import { APP_NAME } from "#/config/shared.ts";
import { sourceLocale } from "#/libs/locale-manifest.ts";

vi.mock("@lingui/core/macro", () => ({
	msg: (descriptor: { id: string }) => descriptor,
}));

const { getEventDefinition } = await import("#/config/notification-events.ts");
const { renderEvent, linkFor, renderSampleEvent } = await import("./render");

const i18n = setupI18n({
	locale: sourceLocale,
	messages: { [sourceLocale]: {} },
});
i18n.activate(sourceLocale);

describe("renderEvent", () => {
	const ctx = {
		i18n,
		user: "admin@example.com",
		serverName: "devbox",
		appName: "PocketBase",
		baseUrl: "https://panel.example.com",
		labels: { server: "Server", app: "App" },
	};

	it("fills templates, translates registry params and links the app", () => {
		const definition = getEventDefinition("job.app_backup.failed");
		if (!definition) throw new Error("missing");
		const message = renderEvent(
			{
				id: "job.app_backup.failed",
				teamId: "t1",
				subject: "d1",
				serverId: "s1",
				appId: "a1",
				params: {
					job: "app_backup",
					title: "Back up PocketBase",
					error: "boom",
				},
				at: new Date("2026-10-05T00:00:00Z"),
			},
			definition,
			ctx,
		);
		expect(message).toEqual({
			eventId: "job.app_backup.failed",
			severity: "error",
			title: "Backup failed: PocketBase",
			body: "Back up PocketBase failed on devbox: boom",
			url: "https://panel.example.com/apps/a1",
			at: new Date("2026-10-05T00:00:00Z"),
			fields: [
				{ label: "Server", value: "devbox" },
				{ label: "App", value: "PocketBase" },
			],
		});
	});

	it("uses the owner email and the event's severity override", () => {
		const definition = getEventDefinition("security.2fa_disabled");
		if (!definition) throw new Error("missing");
		const message = renderEvent(
			{
				id: "security.2fa_disabled",
				teamId: "t1",
				subject: "x",
				params: { ip: "1.2.3.4", action: "auth.2fa.disable" },
				severity: "warning",
			},
			definition,
			{ ...ctx, serverName: null, appName: null },
		);
		expect(message.body).toBe(
			"2FA was turned off for admin@example.com from 1.2.3.4.",
		);
		expect(message.severity).toBe("warning");
		expect(message.url).toBe("https://panel.example.com/settings/security");
	});

	it("has no link without APP_URL", () => {
		expect(linkFor({ appId: "a" }, { category: "jobs" }, null)).toBeNull();
	});
});

describe("event catalog", () => {
	it("marks every security event critical (never deduped or rate limited)", async () => {
		const { notificationEvents } = await import(
			"#/config/notification-events.ts"
		);
		const security = notificationEvents.filter(
			(event) => event.category === "security",
		);
		expect(security.length).toBeGreaterThan(0);
		expect(security.every((event) => event.critical)).toBe(true);
	});
});

describe("renderSampleEvent", () => {
	it("fills every placeholder and prefixes the title", () => {
		const definition = getEventDefinition("security.new_login");
		if (!definition) throw new Error("missing");
		const message = renderSampleEvent(definition, {
			i18n,
			user: "admin@example.com",
			serverName: null,
			appName: null,
			baseUrl: null,
			labels: { server: "Server", app: "App" },
			prefix: "[Test]",
			samples: { ip: "203.0.113.7", default: "example" },
		});
		expect(message.title).toBe(`[Test] New sign-in to ${APP_NAME}`);
		expect(message.body).toContain("203.0.113.7");
		expect(message.body).not.toMatch(/\{\w+\}/);
	});
});
