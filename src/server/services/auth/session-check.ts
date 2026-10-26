/**
 * Whether a session row still authenticates its cookie, and whether its
 * lastSeen should be written now (throttled). Pure (tested).
 */
export interface SessionRowLike {
	userId: string;
	expiresAt: Date;
	lastSeenAt: Date;
	revokedAt: Date | null;
}

export type SessionVerdict =
	| { valid: false; reason: "missing" | "revoked" | "expired" | "user" }
	| { valid: true; touch: boolean };

export function checkSession(
	row: SessionRowLike | null | undefined,
	cookieUserId: string | undefined,
	now: Date,
	touchIntervalMs: number,
): SessionVerdict {
	if (!row) return { valid: false, reason: "missing" };
	if (!cookieUserId || row.userId !== cookieUserId) {
		return { valid: false, reason: "user" };
	}
	if (row.revokedAt) return { valid: false, reason: "revoked" };
	if (row.expiresAt.getTime() <= now.getTime()) {
		return { valid: false, reason: "expired" };
	}
	return {
		valid: true,
		touch: now.getTime() - row.lastSeenAt.getTime() >= touchIntervalMs,
	};
}

/** A login is "new" when no earlier session shares its IP or user agent. */
export function isNewDevice(
	previous: { ip: string | null; userAgent: string | null }[],
	current: { ip: string | null; userAgent: string | null },
): boolean {
	if (previous.length === 0) return false;
	const seenIp = previous.some((row) => row.ip && row.ip === current.ip);
	const seenUa = previous.some(
		(row) => row.userAgent && row.userAgent === current.userAgent,
	);
	return !(seenIp && seenUa);
}
