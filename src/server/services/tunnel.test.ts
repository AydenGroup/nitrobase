import { describe, expect, it } from "vitest";
import {
	isTunnelToken,
	parseTunnelStatus,
	tunnelConfigHash,
	tunnelDownScript,
	tunnelEnvFile,
	tunnelStatusScript,
	tunnelUpScript,
} from "./tunnel";

const settings = {
	container: "nitrobase-cloudflared",
	image: "cloudflare/cloudflared:2025.9.1",
	network: "nitrobase-network",
	envFile: "/etc/nitrobase/tunnel/cloudflared.env",
	metricsPort: 20241,
};
const token = Buffer.from(
	JSON.stringify({
		a: "0123456789abcdef0123456789abcdef",
		t: "11111111-2222-3333-4444-555555555555",
		s: "c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0",
	}),
).toString("base64");

describe("cloudflare tunnel commands", () => {
	it("accepts connector tokens and rejects other text", () => {
		expect(isTunnelToken(token)).toBe(true);
		expect(isTunnelToken(` ${token}\n`)).toBe(true);
		expect(isTunnelToken("not-a-token")).toBe(false);
		expect(
			isTunnelToken(
				Buffer.from(JSON.stringify({ a: "x" }))
					.toString("base64")
					.padEnd(80, "="),
			),
		).toBe(false);
		expect(isTunnelToken(`${token}; rm -rf /`)).toBe(false);
	});

	it("keeps the token out of every command line", () => {
		const hash = tunnelConfigHash(settings, token);
		for (const script of [
			tunnelUpScript(settings, hash),
			tunnelDownScript(settings),
			tunnelStatusScript(settings, "curlimages/curl:8.16.0"),
		]) {
			expect(script).not.toContain(token);
		}
		expect(tunnelEnvFile(token)).toBe(`TUNNEL_TOKEN=${token}\n`);
		const up = tunnelUpScript(settings, hash);
		expect(up).toContain("--env-file '/etc/nitrobase/tunnel/cloudflared.env'");
		expect(up).toContain("--network 'nitrobase-network'");
		expect(up).toContain("tunnel --no-autoupdate --metrics 0.0.0.0:20241 run");
		expect(up).not.toMatch(/-p \d/);
	});

	it("reads and writes the config hash label", () => {
		const up = tunnelUpScript(settings, "abc");
		expect(up).toContain(
			`docker inspect -f '{{.State.Running}} {{index .Config.Labels "nitrobase.config-hash"}}'`,
		);
		expect(up).toContain("--label nitrobase.config-hash=abc \\");
	});

	it("recreates the connector only when its config changes", () => {
		const a = tunnelConfigHash(settings, token);
		expect(tunnelConfigHash(settings, `${token}\n`)).toBe(a);
		expect(tunnelConfigHash({ ...settings, image: "x:2" }, token)).not.toBe(a);
		expect(tunnelConfigHash({ ...settings, network: "other" }, token)).not.toBe(
			a,
		);
		expect(tunnelConfigHash(settings, `${token}A`)).not.toBe(a);
	});

	it("reads the connector state", () => {
		expect(parseTunnelStatus("state=running restarts=0 ready=200").state).toBe(
			"connected",
		);
		expect(parseTunnelStatus("state=running restarts=0 ready=503").state).toBe(
			"connecting",
		);
		// A bad token: cloudflared keeps running but logs failures.
		expect(
			parseTunnelStatus("state=running restarts=0 ready=503 errors=6").state,
		).toBe("failing");
		expect(
			parseTunnelStatus("state=running restarts=0 ready=200 errors=2").state,
		).toBe("connected");
		expect(parseTunnelStatus("state=restarting restarts=4 ready=0")).toEqual({
			state: "failing",
			restarts: 4,
		});
		expect(parseTunnelStatus("state=missing restarts=0 ready=0").state).toBe(
			"stopped",
		);
	});
});
