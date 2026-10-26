import { describe, expect, it } from "vitest";
import {
	APP_NETWORKS_FILE,
	attachNetworksScript,
	type ContainerNetworkState,
	declaresSharedNetworks,
	foreignAliases,
	guardNetworkRepairs,
	networkFileAction,
	networkRepairScript,
	networkStateScript,
	parseNetworkRepairs,
	parseNetworkStateLines,
	planNetworkRepairs,
	renderNetworksFile,
} from "./networks";

describe("files of apps deployed before the fix", () => {
	const old =
		"services:\n  kong:\n    networks:\n      default: {}\n      nitrobase_proxy: {}\nnetworks:\n  nitrobase_proxy:\n    external: true\n";
	const linked =
		"services:\n  db:\n    networks:\n      default: {}\n      nitrobase_link_0123456789abcdef0123456789abcdef: {}\n";
	const fixed =
		"services:\n  kong:\n    labels:\n      nitrobase.routed: 'true'\n    networks:\n      default: {}\n";

	it("finds a deployed compose that still names a shared network", () => {
		expect(declaresSharedNetworks(old)).toBe(true);
		expect(declaresSharedNetworks(linked)).toBe(true);
		expect(declaresSharedNetworks(fixed)).toBe(false);
		expect(declaresSharedNetworks(null)).toBe(false);
	});

	it("rewrites only apps whose stored state is what runs", () => {
		const app = {
			composeDeployed: old,
			status: "running",
			needsRedeploy: false,
			envPendingAt: null,
		};
		expect(networkFileAction(app)).toBe("refresh");
		expect(networkFileAction({ ...app, status: "stopped" })).toBe("refresh");
		expect(networkFileAction({ ...app, composeDeployed: fixed })).toBe("none");
		// Changes waiting for a redeploy would be half-applied: flagged.
		expect(networkFileAction({ ...app, needsRedeploy: true })).toBe("skip");
		expect(networkFileAction({ ...app, envPendingAt: new Date(0) })).toBe(
			"skip",
		);
		expect(networkFileAction({ ...app, status: "error" })).toBe("skip");
		expect(networkFileAction({ ...app, status: "deploying" })).toBe("skip");
	});
});

describe("network repair flap guard", () => {
	const web = { action: "attach" as const, container: "app-web" };
	const db = { action: "realias" as const, container: "app-db" };

	it("stops repairing a container that needs it every tick, until it stays fixed", () => {
		let streak = new Map<string, number>();
		const tick = (
			planned: { action: "attach" | "realias"; container: string }[],
		) => {
			const guard = guardNetworkRepairs(planned, streak, 3);
			streak = guard.streak;
			return guard;
		};
		for (let i = 0; i < 3; i += 1) {
			expect(tick([web, db]).run).toEqual([web, db]);
		}
		// Fourth tick in a row: given up on (one alert), the other was fixed.
		const fourth = tick([web]);
		expect(fourth.run).toEqual([]);
		expect([...fourth.flapping]).toEqual([["app-web", 4]]);
		expect(tick([web]).flapping.get("app-web")).toBe(5);
		// It stays attached for a tick: the streak ends, repairs resume.
		expect(tick([]).flapping.size).toBe(0);
		expect(tick([web]).run).toEqual([web]);
	});
});

const loc = {
	folder: "supabase-0123abcd",
	appRoot: "/etc/nitrobase/apps/supabase-0123abcd",
	appId: "0123abcd-0000-4000-8000-000000000001",
};
const NET = "nitrobase-network";
const ME = "inst-1";

describe("networks file and post-up attach", () => {
	it("lists container/network pairs, validated", () => {
		expect(
			renderNetworksFile([
				{ container: "supabase-0123abcd-kong", network: NET },
				{ container: "supabase-0123abcd-studio", network: NET },
			]),
		).toBe(
			"supabase-0123abcd-kong\tnitrobase-network\nsupabase-0123abcd-studio\tnitrobase-network\n",
		);
		expect(renderNetworksFile([])).toBe("");
		expect(() =>
			renderNetworksFile([{ container: "x; rm -rf /", network: NET }]),
		).toThrow();
	});

	it("connects listed containers of this app only, without an alias", () => {
		const script = attachNetworksScript(loc);
		expect(APP_NETWORKS_FILE).toBe(".nitrobase-networks");
		expect(script).toContain(
			"f='/etc/nitrobase/apps/supabase-0123abcd/.nitrobase-networks'\n",
		);
		// No file (deployed before it existed): nothing to do.
		expect(script).toContain('[ -f "$f" ] || exit 0');
		// Only `<folder>-…` containers and plain network names from the file.
		expect(script).toContain(`case "$c" in 'supabase-0123abcd-'*) ;;`);
		expect(script).toContain("*[!A-Za-z0-9_.-]*) continue");
		// ...that carry this app's label: a squatter of the name fails it.
		expect(script).toContain(
			`if [ "$(docker inspect -f '{{index .Config.Labels "nitrobase.app"}}' "$c")" != '0123abcd-0000-4000-8000-000000000001' ]; then echo "Not attaching $c: not a container of this app" >&2; failed=1; continue; fi`,
		);
		expect(() =>
			attachNetworksScript({ folder: loc.folder, appRoot: loc.appRoot }),
		).toThrow(/App id/);
		expect(script).toContain('docker network connect "$n" "$c"');
		expect(script).not.toContain("--alias");
		// Fails when an attach fails (an attach racing monitoring is fine).
		expect(script).toContain('|| on "$c" "$n" ||');
		expect(script).toContain('exit "$failed"');
		expect(script.startsWith("(")).toBe(true);
		expect(script.endsWith(")")).toBe(true);
	});
});

const row = (
	overrides: Partial<ContainerNetworkState> = {},
): ContainerNetworkState => ({
	name: "supabase-0123abcd-kong",
	id: "4f1e2d3c4b5a69788796a5b4c3d2e1f00112233445566778899aabbccddeeff",
	appLabel: "app-1",
	owner: ME,
	routed: true,
	networks: ["supabase-0123abcd_default", NET],
	aliases: [],
	...overrides,
});

describe("network repairs (monitoring + one-time migration)", () => {
	const settings = { instanceId: ME, network: NET };

	it("finds service-name aliases compose registered on the proxy network", () => {
		// What Compose registers: `<project>-<service>-1` and the service name.
		expect(
			foreignAliases(row({ aliases: ["supabase-0123abcd-kong-1", "kong"] })),
		).toEqual(["supabase-0123abcd-kong-1", "kong"]);
		// `docker network connect`: the container name (and short id on
		// older Docker) only.
		expect(
			foreignAliases(
				row({ aliases: ["supabase-0123abcd-kong", "4f1e2d3c4b5a"] }),
			),
		).toEqual([]);
		expect(foreignAliases(row({ aliases: ["deadbeefcafe"] }))).toEqual([
			"deadbeefcafe",
		]);
	});

	it("plans re-attach and alias drops for this panel's app containers only", () => {
		const rows = [
			row({ aliases: ["supabase-0123abcd-kong-1", "kong"] }),
			row({
				name: "supabase-0123abcd-studio",
				networks: ["supabase-0123abcd_default"],
			}),
			// Clean, unrouted, another panel's, not an app, off and unrouted.
			row({ name: "supabase-0123abcd-ok" }),
			row({ name: "other-kong", owner: "inst-2", aliases: ["kong"] }),
			row({ name: "nitrobase-traefik", appLabel: null, aliases: ["traefik"] }),
			row({ name: "supabase-0123abcd-db", routed: false, networks: [] }),
		];
		expect(planNetworkRepairs(rows, settings)).toEqual([
			{
				action: "realias",
				container: "supabase-0123abcd-kong",
				appId: "app-1",
			},
			{
				action: "attach",
				container: "supabase-0123abcd-studio",
				appId: "app-1",
			},
		]);
		// Without a known instance id nothing is touched.
		expect(planNetworkRepairs(rows, { ...settings, instanceId: null })).toEqual(
			[],
		);
	});

	it("builds the repair commands (disconnect + connect, no alias)", () => {
		const script = networkRepairScript(NET, [
			{ action: "realias", container: "supabase-0123abcd-kong" },
			{ action: "attach", container: "supabase-0123abcd-studio" },
		]);
		const lines = script?.split("\n") ?? [];
		expect(lines[1]).toBe(
			"docker network disconnect 'nitrobase-network' 'supabase-0123abcd-kong' >/dev/null 2>&1; if docker network connect 'nitrobase-network' 'supabase-0123abcd-kong' >/dev/null 2>&1 || on 'supabase-0123abcd-kong'; then echo 'repaired realias supabase-0123abcd-kong'; else echo 'failed realias supabase-0123abcd-kong'; fi",
		);
		expect(lines[2]).toBe(
			"if docker network connect 'nitrobase-network' 'supabase-0123abcd-studio' >/dev/null 2>&1 || on 'supabase-0123abcd-studio'; then echo 'repaired attach supabase-0123abcd-studio'; else echo 'failed attach supabase-0123abcd-studio'; fi",
		);
		expect(script).not.toContain("--alias");
		expect(networkRepairScript(NET, [])).toBeNull();
		expect(() =>
			networkRepairScript(NET, [{ action: "attach", container: "a'b" }]),
		).toThrow();
		expect(
			parseNetworkRepairs(
				"repaired realias supabase-0123abcd-kong\nfailed attach x-studio\nnoise\n",
			),
		).toEqual([
			{ ok: true, action: "realias", container: "supabase-0123abcd-kong" },
			{ ok: false, action: "attach", container: "x-studio" },
		]);
	});

	it("migration scan lists only this panel's app containers", () => {
		const script = networkStateScript(NET, ME);
		expect(script).toContain(
			"ids=$(docker ps -aq --no-trunc --filter 'label=nitrobase.instance=inst-1' --filter 'label=nitrobase.app')",
		);
		expect(script.match(/docker ps -aq/g)).toHaveLength(1);
		expect(script).toContain('{{index .Config.Labels "nitrobase.routed"}}');
		expect(script).toContain(
			'{{with index .NetworkSettings.Networks "nitrobase-network"}}{{join .Aliases ","}}{{end}}',
		);
		const id = row().id as string;
		expect(
			parseNetworkStateLines(
				[
					`/supabase-0123abcd-kong\tapp-1\t${id}\t${ME}\ttrue\tsupabase-0123abcd_default,nitrobase-network,\tsupabase-0123abcd-kong-1,kong`,
					`/supabase-0123abcd-db\tapp-1\t${id}\t${ME}\t<no value>\tsupabase-0123abcd_default,\t`,
					"broken",
				].join("\n"),
			),
		).toEqual([
			row({ aliases: ["supabase-0123abcd-kong-1", "kong"] }),
			row({
				name: "supabase-0123abcd-db",
				routed: false,
				networks: ["supabase-0123abcd_default"],
			}),
		]);
		// The output's last line loses its empty trailing fields to trims:
		// a routed container off every network still needs re-attaching.
		expect(
			parseNetworkStateLines(
				`/supabase-0123abcd-kong\tapp-1\t${id}\t${ME}\ttrue\t\t`.trimEnd(),
			),
		).toEqual([row({ networks: [], aliases: [] })]);
	});
});
