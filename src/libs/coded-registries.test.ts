import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { MessageDescriptor } from "@lingui/core";
import { setupI18n } from "@lingui/core";
import { describe, expect, it } from "vitest";
import { codedTerms } from "#/config/coded-terms.ts";
import { deliveryReasonLabels } from "#/config/git-delivery-reasons.ts";
import {
	cancelStates,
	jobLogEvents,
	jobSteps,
	logEventLevel,
	logEventText,
} from "#/config/job-log-events.ts";
import { jobTitles, titleFor } from "#/config/job-titles.ts";
import { APP_NAME } from "#/config/shared.ts";
import {
	asTerms,
	errorDetail,
	errorInfo,
	errorText,
	formatCodedParams,
	redactCodedParams,
} from "#/libs/coded.ts";
import { errorCodes } from "#/libs/error-codes.ts";
import { localeCodes, sourceLocale } from "#/libs/locale-manifest.ts";
import { errorInfoOf } from "#/server/services/error-info.ts";
import { AppError, coded } from "#/utils/error.ts";

const localesDir = fileURLToPath(new URL("../locales/", import.meta.url));
const catalog = (code: string): Record<string, string> =>
	JSON.parse(readFileSync(`${localesDir}${code}.json`, "utf8"));

/** Every registry of coded server text, by name. */
const registries: Record<string, Record<string, MessageDescriptor>> = {
	errorCodes,
	jobLogEvents: Object.fromEntries(
		Object.entries(jobLogEvents).map(([code, def]) => [code, def.message]),
	),
	jobTitles: Object.fromEntries(
		Object.entries(jobTitles).map(([key, def]) => [key, def.message]),
	),
	jobSteps,
	cancelStates,
	deliveryReasonLabels,
	...Object.fromEntries(
		Object.entries(codedTerms).map(([set, terms]) => [`terms.${set}`, terms]),
	),
};

/** An i18n with the source catalog (message ids are the English text). */
const i18n = setupI18n({
	locale: sourceLocale,
	messages: { [sourceLocale]: {} },
});

describe("coded text registries", () => {
	it.each(
		Object.entries(registries),
	)("%s: every code has a translation in every locale of the manifest", (_, registry) => {
		for (const code of localeCodes) {
			const texts = catalog(code);
			const missing = Object.entries(registry)
				.filter(([, message]) => !texts[message.id as string])
				.map(([key]) => key);
			expect({ locale: code, missing }).toEqual({ locale: code, missing: [] });
		}
	});

	it("log event codes and job title keys are dotted/snake identifiers", () => {
		for (const code of Object.keys(jobLogEvents)) {
			expect(code).toMatch(/^[a-z_]+\.[a-z_]+$/);
		}
		for (const key of Object.keys(jobTitles)) {
			expect(key).toMatch(/^[a-z_]+$/);
		}
	});
});

describe("titleFor", () => {
	it("renders a coded title with its params", () => {
		expect(
			titleFor(i18n, {
				type: "app_move",
				titleParams: { app: "Blog", target: "edge-1" },
			}),
		).toBe("Move Blog to edge-1");
	});

	it("uses the title key when it differs from the kind", () => {
		expect(
			titleFor(i18n, {
				type: "app_redeploy",
				titleKey: "app_rotate",
				titleParams: { name: "JWT_SECRET" },
			}),
		).toBe("Rotate JWT_SECRET");
	});

	it("fills the brand and formats coded params", () => {
		expect(
			titleFor(i18n, {
				type: "panel_upgrade",
				titleParams: { version: "1.2" },
			}),
		).toBe(`Upgrade ${APP_NAME} to 1.2`);
		expect(
			titleFor(i18n, {
				type: "app_recover",
				titleParams: { services: { $list: ["web", "db"] } },
			}),
		).toBe("Recover web and db");
	});

	it("uses the kind's title without params, else the kind itself", () => {
		expect(titleFor(i18n, { type: "bootstrap", titleParams: {} })).toBe(
			"Bootstrap server & Traefik",
		);
		expect(titleFor(i18n, { type: "unknown_kind" })).toBe("unknown_kind");
	});
});

describe("job log events", () => {
	it("render in the reader's language with formatted params", () => {
		expect(
			logEventText(i18n, "backup.uploading", { size: { $bytes: 1536 * 1024 } }),
		).toMatch(/^Uploading 1\.5\sMB\.\.\.$/);
		expect(
			logEventText(i18n, "build.built", {
				image: "app:1",
				duration: { $ms: 65_000 },
			}),
		).toMatch(/^Built app:1 in 1m\s5s$/);
		expect(logEventText(i18n, "unknown.code", {})).toBeNull();
	});

	it("render step and cancel-state keys as their text", () => {
		expect(
			logEventText(i18n, "job.cancelled_state", { state: "move_not_started" }),
		).toBe(
			"Job cancelled. State: nothing was moved: the app runs on the source.",
		);
		expect(
			logEventText(i18n, "job.cancel_requested_wait", { step: "restore_data" }),
		).toMatch(/waiting for “restoring the data”/);
	});

	it("render a nested coded error", () => {
		expect(
			logEventText(i18n, "job.error", {
				error: { $error: coded("APP_NOT_FOUND") },
			}),
		).toBe("ERROR: App not found");
	});

	it("carry a level", () => {
		expect(logEventLevel("deploy.running")).toBe("success");
		expect(logEventLevel("job.error")).toBe("error");
		expect(logEventLevel("restore.sql_warning")).toBe("warning");
		expect(logEventLevel("nope")).toBeNull();
	});
});

describe("coded errors", () => {
	it("store code, params and the source-language text", () => {
		const info = errorInfoOf(
			new AppError("APP_SERVICE_RECREATE_FAILED", {
				service: "web",
				detail: "exit 1",
			}),
		);
		expect(info).toEqual({
			code: "APP_SERVICE_RECREATE_FAILED",
			params: { service: "web", detail: "exit 1" },
			text: "Could not restart web: exit 1",
		});
		expect(errorText(i18n, info)).toBe("Could not restart web.");
		expect(errorDetail(info)).toBe("exit 1");
	});

	it("keep raw text without a code", () => {
		const info = errorInfoOf(new Error("connect ECONNREFUSED"));
		expect(info).toEqual({
			code: null,
			params: null,
			text: "connect ECONNREFUSED",
		});
		expect(errorText(i18n, info)).toBe("connect ECONNREFUSED");
		expect(errorDetail(info)).toBeNull();
	});

	it("rebuild from columns (legacy rows have text only)", () => {
		expect(errorInfo(null, null, null)).toBeNull();
		expect(errorInfo("old English", null, null)).toEqual({
			code: null,
			params: null,
			text: "old English",
		});
		expect(errorText(i18n, errorInfo("x", "APP_NOT_FOUND", {}))).toBe(
			"App not found",
		);
	});

	it("format tagged params for the locale", () => {
		const values = formatCodedParams(i18n, {
			n: 3,
			list: { $list: ["a", "b", "c"] },
			nested: { $error: coded("JOB_CANCELLED") },
		});
		expect(values).toMatchObject({
			appName: APP_NAME,
			n: 3,
			list: "a, b, and c",
			nested: "Cancelled",
		});
	});

	it("render registry ids ($terms) as their labels, unknown ids as is", () => {
		expect(
			formatCodedParams(i18n, {
				risks: asTerms("sql_risk", ["drop_database", "nope"]),
			}),
		).toMatchObject({ risks: "Drops a database and nope" });
		const error = new AppError("SQL_RISK_NOT_ACKNOWLEDGED", {
			risks: asTerms("sql_risk", ["drop_database"]),
		});
		expect(error.message).toBe(
			"Confirm that you understand the risks of this SQL before running it: Drops a database.",
		);
	});

	it("keep the source text as the AppError message (logs, tests)", () => {
		expect(new AppError("DOMAIN_TAKEN", { host: "x.org" }).message).toBe(
			"The domain x.org is already used by another app",
		);
		expect(new AppError("JOB_INTERRUPTED").message).toBe(
			`Interrupted: ${APP_NAME} restarted while this job was running`,
		);
	});
});

describe("redactCodedParams", () => {
	it("redacts strings, list items and nested errors, keeps other values", () => {
		const redact = (text: string) => text.replaceAll("s3cret", "***");
		expect(
			redactCodedParams(
				{
					path: "key=s3cret",
					count: 2,
					size: { $bytes: 10 },
					hosts: { $list: ["a", "s3cret.b"] },
					error: {
						$error: {
							code: "X",
							params: { detail: "token s3cret" },
							text: "failed s3cret",
						},
					},
				},
				redact,
			),
		).toEqual({
			path: "key=***",
			count: 2,
			size: { $bytes: 10 },
			hosts: { $list: ["a", "***.b"] },
			error: {
				$error: {
					code: "X",
					params: { detail: "token ***" },
					text: "failed ***",
				},
			},
		});
	});
});
