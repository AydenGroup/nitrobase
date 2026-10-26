import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { WEBHOOK_HEADERS } from "#/config/identifiers.ts";

/**
 * Push webhook providers (pure). Each provider recognises its requests by
 * header, verifies them against the app's webhook secret and reads the
 * push (branch, commit, message). Every comparison is constant-time on
 * fixed-length digests, so neither content nor length of a secret or a
 * signature leaks through timing.
 *
 * Adding a provider = one entry in `webhookProviders`.
 */

export type HeaderBag = { get(name: string): string | null };

interface PushEvent {
	/** Branch name (refs/heads/ stripped); null for tags and others. */
	branch: string | null;
	commitSha: string | null;
	message: string | null;
	author: string | null;
	/** Branch deleted (no build). */
	deleted: boolean;
}

type VerifyResult =
	| { ok: true }
	| { ok: false; reason: "missing_signature" | "bad_signature" | "stale" };

export interface WebhookProvider {
	id: string;
	/** Display name (product names are not translated). */
	label: string;
	/** Does this request come from this provider? */
	matches(headers: HeaderBag): boolean;
	verify(
		headers: HeaderBag,
		body: Buffer,
		secret: string,
		context: { now: number; toleranceSeconds: number },
	): VerifyResult;
	/** Provider delivery id (replay protection), if sent. */
	deliveryId(headers: HeaderBag): string | null;
	/** Event name; only `isPush` events build. */
	event(headers: HeaderBag): string | null;
	isPush(event: string | null): boolean;
	parse(payload: unknown): PushEvent;
}

/** Constant-time equality of two strings (any lengths). */
export function safeEqual(a: string, b: string): boolean {
	const left = createHash("sha256").update(a, "utf8").digest();
	const right = createHash("sha256").update(b, "utf8").digest();
	return timingSafeEqual(left, right) && a.length === b.length;
}

export function hmacHex(secret: string, data: Buffer | string): string {
	return createHmac("sha256", secret).update(data).digest("hex");
}

const ZERO_SHA = /^0{40}$/;
const SHA = /^[0-9a-f]{40}$/;
const DELIVERY = /^[A-Za-z0-9._:-]{1,128}$/;

const deliveryHeader = (name: string) => (headers: HeaderBag) => {
	const value = headers.get(name)?.trim() ?? "";
	return DELIVERY.test(value) ? value : null;
};

const str = (value: unknown, max = 500): string | null =>
	typeof value === "string" && value ? value.slice(0, max) : null;

const obj = (value: unknown): Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};

export function branchOfRef(ref: unknown): string | null {
	if (typeof ref !== "string" || !ref.startsWith("refs/heads/")) return null;
	const branch = ref.slice("refs/heads/".length);
	return branch && branch.length <= 200 ? branch : null;
}

/** GitHub-shaped push payloads (GitHub, Gitea, Forgejo). */
function parseGitHubStyle(payload: unknown): PushEvent {
	const body = obj(payload);
	const after = str(body.after, 64);
	const head = obj(body.head_commit);
	const author = obj(head.author);
	return {
		branch: branchOfRef(body.ref),
		commitSha: after && SHA.test(after) ? after : null,
		message: str(head.message),
		author: str(author.name) ?? str(author.username),
		deleted: body.deleted === true || (!!after && ZERO_SHA.test(after)),
	};
}

/** `sha256=<hex>` / `<hex>` HMAC of the raw body. */
function verifyHmacHeader(
	headers: HeaderBag,
	names: string[],
	body: Buffer,
	secret: string,
	prefix: string,
): VerifyResult {
	const value = names.map((name) => headers.get(name)).find((item) => !!item);
	if (!value) return { ok: false, reason: "missing_signature" };
	const expected = `${prefix}${hmacHex(secret, body)}`;
	return safeEqual(value.trim().toLowerCase(), expected)
		? { ok: true }
		: { ok: false, reason: "bad_signature" };
}

const github: WebhookProvider = {
	id: "github",
	label: "GitHub",
	matches: (headers) =>
		!!headers.get("x-github-event") &&
		!headers.get("x-gitea-event") &&
		!headers.get("x-forgejo-event"),
	verify: (headers, body, secret) =>
		verifyHmacHeader(headers, ["x-hub-signature-256"], body, secret, "sha256="),
	deliveryId: deliveryHeader("x-github-delivery"),
	event: (headers) => headers.get("x-github-event"),
	isPush: (event) => event === "push",
	parse: parseGitHubStyle,
};

const gitea: WebhookProvider = {
	id: "gitea",
	label: "Gitea / Forgejo",
	matches: (headers) =>
		!!headers.get("x-gitea-event") || !!headers.get("x-forgejo-event"),
	verify: (headers, body, secret) =>
		verifyHmacHeader(
			headers,
			["x-forgejo-signature", "x-gitea-signature"],
			body,
			secret,
			"",
		),
	deliveryId: (headers) =>
		deliveryHeader("x-forgejo-delivery")(headers) ??
		deliveryHeader("x-gitea-delivery")(headers),
	event: (headers) =>
		headers.get("x-forgejo-event") ?? headers.get("x-gitea-event"),
	isPush: (event) => event === "push",
	parse: parseGitHubStyle,
};

const gitlab: WebhookProvider = {
	id: "gitlab",
	label: "GitLab",
	matches: (headers) => !!headers.get("x-gitlab-event"),
	// GitLab sends the secret itself (no HMAC): compared constant-time.
	verify: (headers, _body, secret) => {
		const token = headers.get("x-gitlab-token");
		if (!token) return { ok: false, reason: "missing_signature" };
		return safeEqual(token, secret)
			? { ok: true }
			: { ok: false, reason: "bad_signature" };
	},
	deliveryId: (headers) =>
		deliveryHeader("x-gitlab-event-uuid")(headers) ??
		deliveryHeader("idempotency-key")(headers),
	event: (headers) => headers.get("x-gitlab-event"),
	isPush: (event) => event === "Push Hook",
	parse: (payload) => {
		const body = obj(payload);
		const after = str(body.checkout_sha, 64) ?? str(body.after, 64);
		const commits = Array.isArray(body.commits) ? body.commits : [];
		const last = obj(
			commits.find((commit) => obj(commit).id === after) ?? commits.at(-1),
		);
		return {
			branch: branchOfRef(body.ref),
			commitSha: after && SHA.test(after) ? after : null,
			message: str(last.message),
			author: str(obj(last.author).name) ?? str(body.user_name),
			deleted: !!str(body.after, 64) && ZERO_SHA.test(String(body.after)),
		};
	},
};

/**
 * Any other sender (CI, scripts): a signature header
 * (`x-nitrobase-signature`, `WEBHOOK_HEADERS`): `sha256=<hex>` =
 * HMAC-SHA256(secret, "<timestamp>.<body>") with the timestamp header
 * (unix seconds) inside the tolerance, the same format the panel's own
 * notification webhooks use. Body: `{ "ref" | "branch", "sha"?, ... }`.
 */
const generic: WebhookProvider = {
	id: "generic",
	label: "Generic HMAC",
	matches: (headers) => !!headers.get(WEBHOOK_HEADERS.signature),
	verify: (headers, body, secret, context) => {
		const signature = headers.get(WEBHOOK_HEADERS.signature);
		const timestamp = headers.get(WEBHOOK_HEADERS.timestamp) ?? "";
		if (!signature || !/^\d{1,12}$/.test(timestamp)) {
			return { ok: false, reason: "missing_signature" };
		}
		const expected = `sha256=${hmacHex(
			secret,
			Buffer.concat([Buffer.from(`${timestamp}.`), body]),
		)}`;
		if (!safeEqual(signature.trim().toLowerCase(), expected)) {
			return { ok: false, reason: "bad_signature" };
		}
		const skew = Math.abs(context.now / 1000 - Number(timestamp));
		return skew > context.toleranceSeconds
			? { ok: false, reason: "stale" }
			: { ok: true };
	},
	deliveryId: deliveryHeader(WEBHOOK_HEADERS.delivery),
	event: (headers) => headers.get(WEBHOOK_HEADERS.event) ?? "push",
	isPush: (event) => event === "push",
	parse: (payload) => {
		const body = obj(payload);
		const sha = str(body.sha, 64) ?? str(body.after, 64);
		return {
			branch: branchOfRef(body.ref) ?? str(body.branch, 200),
			commitSha: sha && SHA.test(sha) ? sha : null,
			message: str(body.message),
			author: str(body.author),
			deleted: false,
		};
	},
};

/** Matching order: specific providers first (Gitea also sends X-GitHub-*). */
export const webhookProviders: WebhookProvider[] = [
	gitea,
	gitlab,
	github,
	generic,
];

export function providerFor(headers: HeaderBag): WebhookProvider | null {
	return webhookProviders.find((provider) => provider.matches(headers)) ?? null;
}

/** Generate a webhook secret (hex, 32 bytes of entropy). */
export function newWebhookSecret(random: (size: number) => Buffer): string {
	return random(32).toString("hex");
}

/** Random, URL-safe hook id (not derived from the app id). */
export function newWebhookId(random: (size: number) => Buffer): string {
	return random(24).toString("base64url");
}

export const WEBHOOK_ID_PATTERN = /^[A-Za-z0-9_-]{32}$/;
