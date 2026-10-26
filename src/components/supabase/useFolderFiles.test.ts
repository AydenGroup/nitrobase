// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { type FolderFile, useFolderFiles } from "./useFolderFiles";

const saved: FolderFile[] = [
	{ path: "index.ts", content: "a" },
	{ path: "util.ts", content: "b" },
];

describe("useFolderFiles", () => {
	it("shows the saved files and is clean until the first edit", () => {
		const { result } = renderHook(() => useFolderFiles(saved));
		expect(result.current.working).toEqual(saved);
		expect(result.current.dirty).toBe(false);
	});

	it("is empty while the source is still loading", () => {
		const { result } = renderHook(() => useFolderFiles(undefined));
		expect(result.current.working).toEqual([]);
		expect(result.current.dirty).toBe(false);
	});

	it("marks the folder dirty once files are edited", () => {
		const { result } = renderHook(() => useFolderFiles(saved));
		const edited = [{ path: "index.ts", content: "changed" }];
		act(() => result.current.setFiles(edited));
		expect(result.current.working).toEqual(edited);
		expect(result.current.dirty).toBe(true);
	});

	it("discard returns to the saved files", () => {
		const { result } = renderHook(() => useFolderFiles(saved));
		act(() => result.current.setFiles([{ path: "x.ts", content: "" }]));
		act(() => result.current.discard());
		expect(result.current.working).toEqual(saved);
		expect(result.current.dirty).toBe(false);
	});

	it("follows a refetched source while clean, keeps edits while dirty", () => {
		const next: FolderFile[] = [{ path: "index.ts", content: "server" }];
		const { result, rerender } = renderHook(
			({ source }: { source: FolderFile[] }) => useFolderFiles(source),
			{ initialProps: { source: saved } },
		);
		rerender({ source: next });
		expect(result.current.working).toEqual(next);

		const mine = [{ path: "index.ts", content: "mine" }];
		act(() => result.current.setFiles(mine));
		rerender({ source: saved });
		expect(result.current.working).toEqual(mine);
	});
});
