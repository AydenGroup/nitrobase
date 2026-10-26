import { describe, expect, it } from "vitest";
import {
	branchOfRef,
	hmacHex,
	providerFor,
	safeEqual,
	webhookProviders,
} from "./webhooks";

const SECRET = "s3cret-value";
const body = Buffer.from(
	JSON.stringify({
		ref: "refs/heads/main",
		after: "a".repeat(40),
		head_commit: { message: "Ship it", author: { name: "Jane" } },
	}),
);
const now = 1_791_000_000_000;
const ctx = { now, toleranceSeconds: 300 };

const headers = (entries: Record<string, string>) =>
	new Headers(Object.entries(entries));

function provider(id: string) {
	const found = webhookProviders.find((item) => item.id === id);
	if (!found) throw new Error(id);
	return found;
}

describe("provider detection", () => {
	it("picks Gitea/Forgejo before GitHub (they send X-GitHub-* too)", () => {
		expect(
			providerFor(
				headers({ "x-github-event": "push", "x-gitea-event": "push" }),
			)?.id,
		).toBe("gitea");
		expect(providerFor(headers({ "x-forgejo-event": "push" }))?.id).toBe(
			"gitea",
		);
		expect(providerFor(headers({ "x-github-event": "push" }))?.id).toBe(
			"github",
		);
		expect(providerFor(headers({ "x-gitlab-event": "Push Hook" }))?.id).toBe(
			"gitlab",
		);
		expect(providerFor(headers({ "x-nitrobase-signature": "x" }))?.id).toBe(
			"generic",
		);
		expect(providerFor(headers({}))).toBeNull();
	});
});

describe("GitHub", () => {
	const github = provider("github");
	it("verifies X-Hub-Signature-256", () => {
		const good = headers({
			"x-github-event": "push",
			"x-hub-signature-256": `sha256=${hmacHex(SECRET, body)}`,
		});
		expect(github.verify(good, body, SECRET, ctx)).toEqual({ ok: true });
		expect(
			github.verify(good, Buffer.concat([body, Buffer.from(" ")]), SECRET, ctx),
		).toEqual({ ok: false, reason: "bad_signature" });
		expect(github.verify(good, body, "other", ctx)).toEqual({
			ok: false,
			reason: "bad_signature",
		});
		expect(
			github.verify(headers({ "x-github-event": "push" }), body, SECRET, ctx),
		).toEqual({ ok: false, reason: "missing_signature" });
		// Uppercase hex is the same signature.
		const upper = headers({
			"x-hub-signature-256": `sha256=${hmacHex(SECRET, body).toUpperCase()}`,
		});
		expect(github.verify(upper, body, SECRET, ctx)).toEqual({ ok: true });
	});

	it("reads pushes, delivery ids and events", () => {
		expect(github.parse(JSON.parse(body.toString()))).toEqual({
			branch: "main",
			commitSha: "a".repeat(40),
			message: "Ship it",
			author: "Jane",
			deleted: false,
		});
		expect(
			github.parse({ ref: "refs/heads/main", after: "0".repeat(40) }).deleted,
		).toBe(true);
		expect(github.parse({ ref: "refs/tags/v1" }).branch).toBeNull();
		expect(
			github.deliveryId(headers({ "x-github-delivery": "72d3162e-cc78" })),
		).toBe("72d3162e-cc78");
		expect(
			github.deliveryId(headers({ "x-github-delivery": "bad id with space" })),
		).toBeNull();
		expect(github.isPush("ping")).toBe(false);
	});
});

describe("Gitea / Forgejo", () => {
	const gitea = provider("gitea");
	it("verifies the bare hex HMAC", () => {
		const signed = headers({
			"x-gitea-event": "push",
			"x-gitea-signature": hmacHex(SECRET, body),
		});
		expect(gitea.verify(signed, body, SECRET, ctx)).toEqual({ ok: true });
		const forgejo = headers({
			"x-forgejo-event": "push",
			"x-forgejo-signature": hmacHex(SECRET, body),
		});
		expect(gitea.verify(forgejo, body, SECRET, ctx)).toEqual({ ok: true });
		expect(
			gitea.verify(
				headers({ "x-gitea-signature": `sha256=${hmacHex(SECRET, body)}` }),
				body,
				SECRET,
				ctx,
			),
		).toEqual({ ok: false, reason: "bad_signature" });
		expect(gitea.verify(headers({}), body, SECRET, ctx).ok).toBe(false);
	});
});

describe("GitLab", () => {
	const gitlab = provider("gitlab");
	it("compares X-Gitlab-Token with the secret", () => {
		expect(
			gitlab.verify(headers({ "x-gitlab-token": SECRET }), body, SECRET, ctx),
		).toEqual({ ok: true });
		expect(
			gitlab.verify(
				headers({ "x-gitlab-token": `${SECRET}x` }),
				body,
				SECRET,
				ctx,
			),
		).toEqual({ ok: false, reason: "bad_signature" });
		expect(gitlab.verify(headers({}), body, SECRET, ctx)).toEqual({
			ok: false,
			reason: "missing_signature",
		});
	});

	it("reads GitLab pushes", () => {
		const sha = "c".repeat(40);
		expect(
			gitlab.parse({
				ref: "refs/heads/dev",
				after: sha,
				checkout_sha: sha,
				user_name: "Bob",
				commits: [{ id: sha, message: "Fix", author: { name: "Bob B" } }],
			}),
		).toEqual({
			branch: "dev",
			commitSha: sha,
			message: "Fix",
			author: "Bob B",
			deleted: false,
		});
		expect(gitlab.isPush("Push Hook")).toBe(true);
		expect(gitlab.isPush("Tag Push Hook")).toBe(false);
	});
});

describe("generic HMAC", () => {
	const generic = provider("generic");
	const ts = String(Math.floor(now / 1000));
	const sign = (timestamp: string, data: Buffer) =>
		`sha256=${hmacHex(SECRET, Buffer.concat([Buffer.from(`${timestamp}.`), data]))}`;

	it("verifies the signed timestamp + body", () => {
		const good = headers({
			"x-nitrobase-signature": sign(ts, body),
			"x-nitrobase-timestamp": ts,
		});
		expect(generic.verify(good, body, SECRET, ctx)).toEqual({ ok: true });
	});

	it("rejects replays outside the window and tampered timestamps", () => {
		const old = String(Math.floor(now / 1000) - 3600);
		expect(
			generic.verify(
				headers({
					"x-nitrobase-signature": sign(old, body),
					"x-nitrobase-timestamp": old,
				}),
				body,
				SECRET,
				ctx,
			),
		).toEqual({ ok: false, reason: "stale" });
		// Signature of the old timestamp presented with a fresh one.
		expect(
			generic.verify(
				headers({
					"x-nitrobase-signature": sign(old, body),
					"x-nitrobase-timestamp": ts,
				}),
				body,
				SECRET,
				ctx,
			),
		).toEqual({ ok: false, reason: "bad_signature" });
		expect(
			generic.verify(
				headers({ "x-nitrobase-signature": sign(ts, body) }),
				body,
				SECRET,
				ctx,
			),
		).toEqual({ ok: false, reason: "missing_signature" });
	});

	it("reads its event and delivery headers", () => {
		const request = headers({
			"x-nitrobase-signature": sign(ts, body),
			"x-nitrobase-timestamp": ts,
			"x-nitrobase-event": "ping",
			"x-nitrobase-delivery": "d-1",
		});
		expect(providerFor(request)?.id).toBe("generic");
		expect(generic.verify(request, body, SECRET, ctx)).toEqual({ ok: true });
		expect(generic.event(request)).toBe("ping");
		expect(generic.deliveryId(request)).toBe("d-1");
	});

	it("ignores headers of another prefix", () => {
		const request = headers({
			"x-other-signature": sign(ts, body),
			"x-other-timestamp": ts,
		});
		expect(providerFor(request)?.id).not.toBe("generic");
	});

	it("accepts ref or branch", () => {
		expect(generic.parse({ branch: "main" }).branch).toBe("main");
		expect(generic.parse({ ref: "refs/heads/x" }).branch).toBe("x");
	});
});

describe("helpers", () => {
	it("compares in constant time regardless of length", () => {
		expect(safeEqual("abc", "abc")).toBe(true);
		expect(safeEqual("abc", "abd")).toBe(false);
		expect(safeEqual("abc", "abcd")).toBe(false);
		expect(safeEqual("", "")).toBe(true);
	});
	it("reads branch refs only", () => {
		expect(branchOfRef("refs/heads/feature/x")).toBe("feature/x");
		expect(branchOfRef("refs/tags/v1")).toBeNull();
		expect(branchOfRef(42)).toBeNull();
	});
});
