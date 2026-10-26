import { describe, expect, it } from "vitest";
import {
	createResizer,
	PtyMarkerReader,
	ptyBootstrap,
	resizeCommand,
} from "./local-pty";

const marker = (path: string) => `\x1b]697;nitrobase-tty=${path}\x07`;

describe("PtyMarkerReader", () => {
	it("strips the marker and keeps the path", () => {
		const reader = new PtyMarkerReader();
		expect(reader.push(`${marker("/dev/pts/3")}$ `)).toBe("$ ");
		expect(reader.path).toBe("/dev/pts/3");
		expect(reader.push("ls\r\n")).toBe("ls\r\n");
	});

	it("handles a marker split across chunks", () => {
		const reader = new PtyMarkerReader();
		const full = `${marker("/dev/pts/12")}hello`;
		let out = "";
		for (const char of full) out += reader.push(char);
		expect(out).toBe("hello");
		expect(reader.path).toBe("/dev/pts/12");
	});

	it("passes through output without a marker", () => {
		const reader = new PtyMarkerReader();
		expect(reader.push("nsenter: failed")).toBe("nsenter: failed");
		expect(reader.path).toBeNull();
	});

	it("ignores a later look-alike and bad paths", () => {
		const reader = new PtyMarkerReader();
		expect(reader.push("$ ")).toBe("$ ");
		expect(reader.push(marker("/dev/pts/1"))).toBe(marker("/dev/pts/1"));
		expect(reader.path).toBeNull();

		const bad = new PtyMarkerReader();
		expect(bad.push(`${marker("/etc/passwd; rm -rf /")}x`)).toBe("x");
		expect(bad.path).toBeNull();
	});
});

describe("resize commands", () => {
	it("builds stty commands only for PTY paths", () => {
		expect(resizeCommand("/dev/pts/4", 40, 120)).toBe(
			"stty -F /dev/pts/4 rows 40 cols 120",
		);
		expect(() => resizeCommand("/dev/sda", 1, 1)).toThrow();
		expect(ptyBootstrap("bash", 24, 80)).toContain(
			"stty rows 24 cols 80; bash",
		);
	});

	it("runs resizes in order and coalesces bursts", async () => {
		const calls: string[] = [];
		let release: () => void = () => {};
		const resize = createResizer(
			(rows, cols) =>
				new Promise<void>((resolve) => {
					calls.push(`${rows}x${cols}`);
					release = resolve;
				}),
		);
		resize(10, 10);
		resize(20, 20);
		resize(30, 30);
		release();
		await new Promise((resolve) => setTimeout(resolve, 0));
		release();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(calls).toEqual(["10x10", "30x30"]);
	});
});
