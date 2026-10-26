import { describe, expect, it } from "vitest";
import { decideIdentity } from "./instance-state";

describe("instance identity", () => {
	it("adopts an id on first boot or upgrade", () => {
		expect(decideIdentity(null, null)).toEqual({ state: "adopt" });
		expect(decideIdentity(null, "abc")).toEqual({ state: "adopt" });
	});
	it("runs only when the marker matches the database", () => {
		expect(decideIdentity("abc", "abc")).toEqual({ state: "match" });
		// A restored/cloned database on another machine.
		expect(decideIdentity("abc", "xyz")).toEqual({
			state: "paused",
			reason: "mismatch",
		});
		// The database knows an instance, this machine has no marker.
		expect(decideIdentity("abc", null)).toEqual({
			state: "paused",
			reason: "marker_missing",
		});
	});
});
