import { describe, expect, it } from "vitest";
import { resolveSelection } from "./folderSelection";

const fns = [{ name: "hello" }, { name: "watch" }];
const shared = [{ name: "_shared" }, { name: "lib" }];

describe("resolveSelection", () => {
	it("keeps a selected function that still exists", () => {
		expect(
			resolveSelection({ kind: "function", name: "watch" }, fns, shared),
		).toEqual({ kind: "function", name: "watch" });
	});

	it("keeps a selected shared folder that still exists", () => {
		expect(
			resolveSelection({ kind: "shared", name: "lib" }, fns, shared),
		).toEqual({ kind: "shared", name: "lib" });
	});

	it("falls back to the first function when the selection is gone", () => {
		expect(
			resolveSelection({ kind: "function", name: "gone" }, fns, shared),
		).toEqual({ kind: "function", name: "hello" });
	});

	it("falls back to the first function when nothing is selected", () => {
		expect(resolveSelection(null, fns, shared)).toEqual({
			kind: "function",
			name: "hello",
		});
	});

	it("falls back to the first shared folder when there are no functions", () => {
		expect(resolveSelection(null, [], shared)).toEqual({
			kind: "shared",
			name: "_shared",
		});
		expect(
			resolveSelection({ kind: "function", name: "x" }, [], shared),
		).toEqual({ kind: "shared", name: "_shared" });
	});

	it("is null when there is nothing at all", () => {
		expect(resolveSelection(null, [], [])).toBeNull();
	});

	it("does not mix kinds: a shared name is not matched in the function list", () => {
		expect(
			resolveSelection({ kind: "shared", name: "watch" }, fns, shared),
		).toEqual({ kind: "function", name: "hello" });
	});
});
