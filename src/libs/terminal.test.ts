import { describe, expect, it } from "vitest";
import textSamples from "#/__fixtures__/text-samples.json";
import {
	chunkTerminalInput,
	clampInt,
	isSameOriginUpgrade,
	MAX_INPUT_BYTES,
	parseTerminalMessage,
} from "./terminal";

describe("clampInt", () => {
	it("clamps to min/max and truncates floats", () => {
		expect(clampInt(0, 5, 200, 24)).toBe(5);
		expect(clampInt(1000, 5, 200, 24)).toBe(200);
		expect(clampInt(80.9, 5, 200, 24)).toBe(80);
	});

	it("falls back on non-finite values", () => {
		expect(clampInt("80", 5, 200, 24)).toBe(24);
		expect(clampInt(Number.NaN, 5, 200, 24)).toBe(24);
		expect(clampInt(undefined, 5, 200, 24)).toBe(24);
	});
});

// Size bounds under test: rows 5..200, cols 10..500 (see terminal.ts).
describe("parseTerminalMessage", () => {
	it("parses input", () => {
		expect(parseTerminalMessage('{"type":"input","data":"ls\\n"}')).toEqual({
			kind: "input",
			data: "ls\n",
		});
	});

	it("parses resize with clamping", () => {
		expect(
			parseTerminalMessage('{"type":"resize","rows":100,"cols":200}'),
		).toEqual({
			kind: "resize",
			rows: 100,
			cols: 200,
		});
		expect(
			parseTerminalMessage('{"type":"resize","rows":1,"cols":9999}'),
		).toEqual({
			kind: "resize",
			rows: 5,
			cols: 500,
		});
	});

	it("rejects oversized messages", () => {
		expect(parseTerminalMessage("x".repeat(MAX_INPUT_BYTES + 1))).toEqual({
			kind: "rejected",
			size: MAX_INPUT_BYTES + 1,
		});
	});

	it("falls back to raw text for non-JSON", () => {
		expect(parseTerminalMessage("cd /tmp\n")).toEqual({
			kind: "raw",
			data: "cd /tmp\n",
		});
	});

	it("ignores unknown JSON types", () => {
		expect(parseTerminalMessage('{"type":"ping"}')).toBeNull();
	});
});

describe("isSameOriginUpgrade", () => {
	const headers = (init: Record<string, string>) => new Headers(init);

	it("accepts matching origin and host", () => {
		expect(
			isSameOriginUpgrade(
				headers({ origin: "http://localhost:3000", host: "localhost:3000" }),
			),
		).toBe(true);
	});

	it("accepts origin matching X-Forwarded-Host", () => {
		expect(
			isSameOriginUpgrade(
				headers({
					origin: "https://panel.example.org",
					host: "nitrobase:3000",
					"x-forwarded-host": "panel.example.org",
				}),
			),
		).toBe(true);
	});

	it("rejects foreign or missing origin", () => {
		expect(
			isSameOriginUpgrade(
				headers({ origin: "https://evil.test", host: "localhost:3000" }),
			),
		).toBe(false);
		expect(isSameOriginUpgrade(headers({ host: "localhost:3000" }))).toBe(
			false,
		);
		expect(
			isSameOriginUpgrade(headers({ origin: "null", host: "localhost:3000" })),
		).toBe(false);
	});
});

describe("chunkTerminalInput", () => {
	const decode = (frames: string[]) =>
		frames
			.map((frame) => {
				const parsed = parseTerminalMessage(frame);
				if (parsed?.kind !== "input") throw new Error("not input");
				return parsed.data;
			})
			.join("");

	it("keeps small input in one frame", () => {
		expect(chunkTerminalInput("ls\n")).toEqual([
			'{"type":"input","data":"ls\\n"}',
		]);
	});

	it("splits a large paste into in-order frames under the limit", () => {
		const paste = Array.from({ length: 2000 }, (_, i) => `line ${i}\n`).join(
			"",
		);
		const frames = chunkTerminalInput(paste);
		expect(frames.length).toBeGreaterThan(1);
		for (const frame of frames) {
			expect(frame.length).toBeLessThanOrEqual(MAX_INPUT_BYTES);
		}
		expect(decode(frames)).toBe(paste);
	});

	it("accounts for JSON escaping of control characters", () => {
		const paste = "\u0001".repeat(MAX_INPUT_BYTES);
		const frames = chunkTerminalInput(paste);
		for (const frame of frames) {
			expect(frame.length).toBeLessThanOrEqual(MAX_INPUT_BYTES);
		}
		expect(decode(frames)).toBe(paste);
	});

	it("never splits surrogate pairs or multi-byte text", () => {
		const paste = `${textSamples.samples.join(" ")} `.repeat(200);
		const frames = chunkTerminalInput(paste, 64);
		for (const frame of frames) {
			expect(frame.length).toBeLessThanOrEqual(64);
			const data = JSON.parse(frame).data as string;
			expect(data).not.toMatch(
				/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
			);
		}
		expect(decode(frames)).toBe(paste);
	});
});
