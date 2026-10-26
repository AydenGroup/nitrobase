import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
	msg: (descriptor: { id: string }) => descriptor,
}));

const { channelDrivers, channelFields } = await import(
	"./notification-channels"
);
const { isPrivateHost, formIssues, describeSchemaError } = await import(
	"./schema-fields"
);

const fieldsOf = (type: string) => {
	const driver = channelDrivers.find((item) => item.type === type);
	if (!driver) throw new Error(type);
	return Object.fromEntries(
		channelFields(driver).map((field) => [field.name, field.kind]),
	);
};

describe("schemaFields", () => {
	it("detects numbers, enums, booleans and strings", () => {
		expect(fieldsOf("email")).toMatchObject({
			host: "string",
			port: "number",
			security: "enum",
			privateNetwork: "boolean",
			password: "string",
		});
	});
});

describe("channel config rules (SSRF)", () => {
	const parse = (type: string, config: Record<string, unknown>) =>
		channelDrivers.find((item) => item.type === type)?.schema.safeParse(config)
			.success;

	it("needs https to a public host unless private network is on", () => {
		const hook = { signingSecret: "a".repeat(64) };
		expect(parse("webhook", { ...hook, url: "https://example.com/h" })).toBe(
			true,
		);
		expect(parse("webhook", { ...hook, url: "http://example.com/h" })).toBe(
			false,
		);
		expect(parse("webhook", { ...hook, url: "https://10.0.0.5/h" })).toBe(
			false,
		);
		expect(parse("webhook", { ...hook, url: "https://[::1]/h" })).toBe(false);
		expect(
			parse("webhook", {
				...hook,
				url: "http://10.0.0.5/h",
				privateNetwork: true,
			}),
		).toBe(true);
		expect(
			parse("discord", { webhookUrl: "https://169.254.169.254/latest" }),
		).toBe(false);
		expect(
			parse("email", {
				host: "127.0.0.1",
				from: "a@b.co",
				to: "c@d.co",
			}),
		).toBe(false);
		expect(
			parse("email", {
				host: "smtp.example.com",
				security: "none",
				from: "a@b.co",
				to: "c@d.co",
			}),
		).toBe(false);
	});

	it("flags private and mapped addresses", () => {
		for (const host of [
			"127.0.0.1",
			"10.1.2.3",
			"192.168.1.1",
			"172.20.0.1",
			"::ffff:127.0.0.1",
			"fd00::1",
			"localhost",
			"100.64.0.1",
		]) {
			expect(isPrivateHost(host)).toBe(true);
		}
		for (const host of ["8.8.8.8", "example.com", "172.32.0.1"]) {
			expect(isPrivateHost(host)).toBe(false);
		}
	});
});

describe("formIssues", () => {
	const telegram = channelDrivers.find((item) => item.type === "telegram");
	const webhook = channelDrivers.find((item) => item.type === "webhook");
	if (!telegram || !webhook) throw new Error("drivers");

	it("reports per field with translatable message ids", () => {
		expect(
			formIssues(telegram.schema, { botToken: "nope", chatId: "" }),
		).toEqual({
			botToken: "The token from @BotFather",
			chatId: "This field is required",
		});
	});

	it("skips secrets kept on edit and generated fields", () => {
		const issues = formIssues(
			webhook.schema,
			{ url: "http://10.0.0.1/hook", secret: "" },
			{ editing: true, secretMask: "********" },
		);
		expect(issues.secret).toBeUndefined();
		expect(issues.url).toBe(
			"Use https to a public host, or enable private network",
		);
	});

	it("names the field and keeps the zod message as detail", () => {
		const parsed = telegram.schema.safeParse({
			botToken: "nope",
			chatId: "1",
		});
		if (parsed.success) throw new Error("expected failure");
		expect(describeSchemaError(telegram.schema, parsed.error)).toEqual({
			field: "botToken",
			detail: "The token from @BotFather",
		});
	});
});
