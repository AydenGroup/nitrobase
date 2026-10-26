import type { I18n } from "@lingui/core";
import { getConfig } from "#/config/server.ts";
import { getExistedUser } from "#/features/auth/auth.server.ts";
import {
	claimRestoreSlot,
	receiveUpload,
	releaseRestoreSlot,
	restoreFromSelfBackup,
} from "#/features/setup/first-run-restore.server.ts";
import { formatBytes } from "#/libs/intl.ts";
import { PanelArchiveError } from "#/server/services/backup/panel-archive.ts";
import { createRateLimiter } from "#/server/services/rate-limit.ts";
import { currentRequestInfo } from "#/server/services/request-info.ts";
import { setupTokenMatches } from "#/server/services/setup-token.ts";
import { AppError, getAppErrorMessage } from "#/utils/error.ts";

/** Restore attempts per client address per window (a restore is heavy). */
let limiter: ReturnType<typeof createRateLimiter> | null = null;
const restoreLimiter = () => {
	const config = getConfig();
	limiter ??= createRateLimiter({
		limit: config.FIRST_RUN_RESTORE_RATE_LIMIT,
		windowMs: config.FIRST_RUN_RESTORE_RATE_WINDOW_MS,
	});
	return limiter;
};

/** Same-origin requests only; a missing Origin (non-browser client) passes. */
function sameOrigin(request: Request): boolean {
	const origin = request.headers.get("origin");
	if (origin === null) return true;
	try {
		return new URL(origin).host === new URL(request.url).host;
	} catch {
		// `Origin: null` (sandboxed frame, file://) and garbage.
		return false;
	}
}

function decodeHeader(value: string | null): string {
	if (!value) return "";
	try {
		return Buffer.from(value, "base64").toString("utf8");
	} catch {
		return "";
	}
}

/**
 * First-run "Restore Nitrobase from a self-backup". The body is the raw
 * `.tar.gz.enc` file (streamed to disk with a byte cap); the setup token,
 * the noted sha256 and the old ENCRYPTION_KEY (base64) come in headers.
 * Public like the first sign-up, and like it refused as soon as any
 * account exists (checked again under the sign-up lock); one at a time.
 */
export async function firstRunRestoreResponse(
	request: Request,
	i18n: I18n,
): Promise<Response> {
	const config = getConfig();
	const fail = (error: AppError, status: number) =>
		Response.json(
			{ code: error.code, message: getAppErrorMessage(i18n, error) },
			{ status },
		);
	if (!sameOrigin(request)) {
		return Response.json({ message: "Bad origin" }, { status: 403 });
	}
	if (await getExistedUser()) {
		return fail(new AppError("RESTORE_NOT_EMPTY"), 409);
	}
	const ip = currentRequestInfo().ip ?? "unknown";
	if (restoreLimiter().isLimited(ip)) {
		return Response.json({ message: "Too many attempts" }, { status: 429 });
	}
	restoreLimiter().hit(ip);
	if (!setupTokenMatches(request.headers.get("x-setup-token"))) {
		return fail(new AppError("SETUP_TOKEN_INVALID"), 403);
	}
	const key = decodeHeader(request.headers.get("x-encryption-key"));
	const expectedSha256 = request.headers.get("x-backup-sha256") ?? "";
	if (key.length < config.FIRST_RUN_RESTORE_KEY_MIN_LENGTH || !request.body) {
		return Response.json({ message: "Bad request" }, { status: 400 });
	}
	const tooLarge = () =>
		fail(
			new AppError("RESTORE_TOO_LARGE", {
				max: formatBytes(i18n.locale, config.FIRST_RUN_RESTORE_MAX_BYTES),
			}),
			413,
		);
	const length = Number(request.headers.get("content-length") ?? 0);
	if (length > config.FIRST_RUN_RESTORE_MAX_BYTES) return tooLarge();
	if (!claimRestoreSlot()) return fail(new AppError("RESTORE_BUSY"), 409);
	try {
		let upload: Awaited<ReturnType<typeof receiveUpload>>;
		try {
			upload = await receiveUpload(
				request.body as unknown as AsyncIterable<Uint8Array>,
			);
		} catch (error) {
			if (error instanceof PanelArchiveError) return tooLarge();
			throw error;
		}
		const result = await restoreFromSelfBackup({
			...upload,
			expectedSha256,
			key,
		});
		return Response.json(result);
	} catch (error) {
		if (error instanceof AppError) {
			return fail(error, error.code === "RESTORE_NOT_EMPTY" ? 409 : 422);
		}
		console.error("[setup] first-run restore failed", error);
		return Response.json(
			{ message: getAppErrorMessage(i18n, error) },
			{ status: 500 },
		);
	} finally {
		releaseRestoreSlot();
	}
}
