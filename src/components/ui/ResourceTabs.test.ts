import { describe, expect, it } from "vitest";
import { groupTabItems, resolveTab } from "./ResourceTabs";

describe("resolveTab", () => {
	const items = [{ id: "overview" }, { id: "logs" }, { id: "settings" }];

	it("keeps a visible tab", () => {
		expect(resolveTab("logs", items)).toBe("logs");
	});

	it("falls back to overview for a hidden or unknown tab", () => {
		// e.g. ?tab=terminal without app.terminal, or another template's plugin tab.
		expect(resolveTab("terminal", items)).toBe("overview");
		expect(resolveTab("supabase-api", items)).toBe("overview");
	});

	it("falls back to the first tab without an overview", () => {
		expect(resolveTab("x", [{ id: "a" }, { id: "b" }])).toBe("a");
		expect(resolveTab("x", [])).toBe("overview");
	});
});

describe("groupTabItems", () => {
	it("groups consecutive tabs by section, keeping order", () => {
		const groups = groupTabItems([
			{ id: "overview", label: "Overview" },
			{ id: "logs", label: "Logs" },
			{ id: "api", label: "API", section: { id: "plugin", label: "Supabase" } },
			{
				id: "sync",
				label: "Cloud sync",
				section: { id: "plugin", label: "Supabase" },
			},
			{ id: "settings", label: "Settings", section: { id: "settings" } },
		]);
		expect(
			groups.map((group) => [
				group.id,
				group.label,
				group.items.map((item) => item.id),
			]),
		).toEqual([
			["", undefined, ["overview", "logs"]],
			["plugin", "Supabase", ["api", "sync"]],
			["settings", undefined, ["settings"]],
		]);
	});

	it("returns no groups for no tabs", () => {
		expect(groupTabItems([])).toEqual([]);
	});
});
