import { describe, expect, it } from "vitest";
import { composeWithOverlay, mergeOverlay, parseOverlay } from "./overlay";

describe("mergeOverlay", () => {
	it("merges mappings, replaces lists and scalars, null removes", () => {
		const base = {
			services: {
				web: { image: "a", environment: ["A=1"], ports: ["80:80"] },
				proxy: { image: "traefik" },
			},
			networks: { gateway: {}, default: {} },
		};
		const merged = mergeOverlay(base, {
			services: {
				web: { image: "b", environment: ["B=2"], labels: { x: "1" } },
				proxy: null,
			},
			networks: { gateway: null },
		});
		expect(merged).toEqual({
			services: {
				web: {
					image: "b",
					environment: ["B=2"],
					ports: ["80:80"],
					labels: { x: "1" },
				},
			},
			networks: { default: {} },
		});
		// Inputs are not mutated.
		expect(base.services.proxy).toEqual({ image: "traefik" });
	});

	it("parses overlays with the compose YAML rules", () => {
		expect(parseOverlay("")).toEqual({});
		expect(() => parseOverlay("- a")).toThrow(/mapping/);
		const anchors = "x: &a {image: y}\nservices:\n  w:\n    <<: *a\n";
		// Merge keys are applied, never left in the tree.
		expect(parseOverlay(anchors)).toMatchObject({
			services: { w: { image: "y" } },
		});
	});

	it("applies an overlay to a compose file", () => {
		expect(
			composeWithOverlay(
				"services:\n  db:\n    image: postgres\n    environment: [POSTGRES_PASSWORD=postgres]\n",
				'services:\n  db:\n    environment: ["POSTGRES_PASSWORD=${DB_PASSWORD}"]\n',
			),
		).toEqual({
			services: {
				db: {
					image: "postgres",
					environment: ["POSTGRES_PASSWORD=${DB_PASSWORD}"],
				},
			},
		});
	});
});
