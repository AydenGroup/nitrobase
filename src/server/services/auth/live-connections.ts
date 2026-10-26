/**
 * Registry of long-lived authenticated connections (terminal WebSockets,
 * SSE streams) by session id. Revoking a session closes its connections
 * immediately; a periodic re-validation (backstop) closes connections whose
 * session expired, was revoked elsewhere or whose user is gone.
 *
 * In-process (single Nitrobase instance, like the job runner).
 */

/**
 * Why a live connection was closed: the session ended, or (`forbidden`)
 * the member left the team / their role lost the connection's permission.
 */
export type SessionEndReason = "revoked" | "expired" | "invalid" | "forbidden";

/** Abort reason of a session-bound signal. */
export class SessionEndedError extends Error {
	constructor(readonly reason: SessionEndReason) {
		// Internal (the client acts on `reason`; texts are translated there).
		super(`session ended: ${reason}`);
		this.name = "SessionEndedError";
	}
}

export interface LiveConnection {
	sessionId: string;
	userId: string;
	/**
	 * Team and permission the connection was opened with: it is closed when
	 * the member leaves the team or their role no longer grants it.
	 */
	access?: { teamId: string; permission: string };
	/** Close the connection (send a final message first if possible). */
	close(error: SessionEndedError): void;
}

/**
 * Checks sessions in bulk: session id -> null while it still authenticates
 * its user, else why it ended. Missing ids count as invalid.
 */
export type SessionValidator = (
	sessions: { sessionId: string; userId: string }[],
) => Promise<Map<string, SessionEndReason | null>>;

/**
 * Checks team access in bulk: returns the keys (`accessKey`) of entries
 * that are no longer allowed.
 */
export type AccessValidator = (
	entries: { userId: string; teamId: string; permission: string }[],
) => Promise<Set<string>>;

export const accessKey = (entry: {
	userId: string;
	teamId: string;
	permission: string;
}) => `${entry.userId}|${entry.teamId}|${entry.permission}`;

interface RegistryState {
	connections: Set<LiveConnection>;
	timer: ReturnType<typeof setInterval> | null;
	validator: SessionValidator | null;
	accessValidator?: AccessValidator | null;
	intervalMs: number;
	checking: boolean;
}

const globalState = globalThis as typeof globalThis & {
	__nitrobaseLiveConnections?: RegistryState;
};
globalState.__nitrobaseLiveConnections ??= {
	connections: new Set(),
	timer: null,
	validator: null,
	intervalMs: 30_000,
	checking: false,
};
const state = globalState.__nitrobaseLiveConnections;

/** Wire the re-validation backstop (called once by the auth layer). */
export function configureRevalidation(
	validator: SessionValidator,
	intervalMs: number,
): void {
	state.validator = validator;
	state.intervalMs = intervalMs;
	if (state.timer) {
		clearInterval(state.timer);
		state.timer = null;
	}
	ensureTimer();
}

function ensureTimer(): void {
	if (state.timer || !state.validator || state.connections.size === 0) return;
	state.timer = setInterval(() => {
		void revalidateNow();
	}, state.intervalMs);
	state.timer.unref?.();
}

function stopTimerIfIdle(): void {
	if (state.connections.size === 0 && state.timer) {
		clearInterval(state.timer);
		state.timer = null;
	}
}

function closeAll(
	predicate: (connection: LiveConnection) => boolean,
	error: SessionEndedError,
): number {
	let closed = 0;
	for (const connection of [...state.connections]) {
		if (!predicate(connection)) continue;
		state.connections.delete(connection);
		closed++;
		try {
			connection.close(error);
		} catch {
			// already closed
		}
	}
	stopTimerIfIdle();
	return closed;
}

/** Track a connection until the returned function is called. */
export function registerConnection(connection: LiveConnection): () => void {
	state.connections.add(connection);
	ensureTimer();
	return () => {
		state.connections.delete(connection);
		stopTimerIfIdle();
	};
}

/** Wire the team-access re-check (called once by the teams layer). */
export function configureAccessRevalidation(validator: AccessValidator): void {
	state.accessValidator = validator;
}

/**
 * Close a member's connections in a team that `allowed` no longer permits
 * (member removed: nothing is allowed). Returns how many were closed.
 */
export function endMemberConnections(
	teamId: string,
	userId: string,
	allowed: (permission: string) => boolean = () => false,
): number {
	return closeAll(
		(connection) =>
			connection.userId === userId &&
			connection.access?.teamId === teamId &&
			!allowed(connection.access.permission),
		new SessionEndedError("forbidden"),
	);
}

/** Close every connection opened in a team (team deleted). */
export function endTeamConnections(teamId: string): number {
	return closeAll(
		(connection) => connection.access?.teamId === teamId,
		new SessionEndedError("forbidden"),
	);
}

/** Close every connection of one session. Returns how many were closed. */
export function endSessionConnections(
	sessionId: string,
	reason: SessionEndReason = "revoked",
): number {
	return closeAll(
		(connection) => connection.sessionId === sessionId,
		new SessionEndedError(reason),
	);
}

/** Close every connection of a user, except those of `exceptSessionId`. */
export function endUserConnections(
	userId: string,
	options: { exceptSessionId?: string } = {},
): number {
	return closeAll(
		(connection) =>
			connection.userId === userId &&
			connection.sessionId !== options.exceptSessionId,
		new SessionEndedError("revoked"),
	);
}

/** One re-validation pass (exported for tests and the interval). */
export async function revalidateNow(): Promise<number> {
	if (!state.validator || state.checking || state.connections.size === 0)
		return 0;
	state.checking = true;
	try {
		const unique = new Map<string, { sessionId: string; userId: string }>();
		for (const connection of state.connections) {
			unique.set(`${connection.sessionId}|${connection.userId}`, {
				sessionId: connection.sessionId,
				userId: connection.userId,
			});
		}
		const verdicts = await state.validator([...unique.values()]);
		let closed = 0;
		for (const [key, entry] of unique) {
			const reason = verdicts.has(entry.sessionId)
				? verdicts.get(entry.sessionId)
				: "invalid";
			if (!reason) continue;
			closed += closeAll(
				(connection) => `${connection.sessionId}|${connection.userId}` === key,
				new SessionEndedError(reason),
			);
		}
		if (state.accessValidator) {
			const entries = new Map<
				string,
				{ userId: string; teamId: string; permission: string }
			>();
			for (const connection of state.connections) {
				if (!connection.access) continue;
				const entry = { userId: connection.userId, ...connection.access };
				entries.set(accessKey(entry), entry);
			}
			if (entries.size) {
				const denied = await state.accessValidator([...entries.values()]);
				for (const key of denied) {
					closed += closeAll(
						(connection) =>
							!!connection.access &&
							accessKey({
								userId: connection.userId,
								...connection.access,
							}) === key,
						new SessionEndedError("forbidden"),
					);
				}
			}
		}
		return closed;
	} catch {
		// DB hiccup: keep connections, retry next interval.
		return 0;
	} finally {
		state.checking = false;
	}
}

/**
 * An AbortSignal for a long-lived response: aborted when `parent` aborts or
 * when the session ends (reason = SessionEndedError). Call `release` when
 * the response is done.
 */
export function sessionBoundSignal(
	session: Omit<LiveConnection, "close">,
	parent?: AbortSignal,
): { signal: AbortSignal; release: () => void } {
	const controller = new AbortController();
	let unregister = () => {};
	const release = () => {
		unregister();
		parent?.removeEventListener("abort", onParentAbort);
	};
	const onParentAbort = () => {
		release();
		controller.abort(parent?.reason);
	};
	if (parent?.aborted) {
		controller.abort(parent.reason);
		return { signal: controller.signal, release };
	}
	parent?.addEventListener("abort", onParentAbort, { once: true });
	unregister = registerConnection({
		...session,
		close: (error) => {
			release();
			controller.abort(error);
		},
	});
	return { signal: controller.signal, release };
}

/** Final SSE payload (message + reason) when the session/access ended. */
export function sessionEndedPayload(
	signal: AbortSignal,
): { message: string; reason: SessionEndReason } | null {
	return signal.reason instanceof SessionEndedError
		? { message: signal.reason.message, reason: signal.reason.reason }
		: null;
}

/** Test helper: forget every connection and the validator. */
export function resetLiveConnections(): void {
	state.connections.clear();
	if (state.timer) clearInterval(state.timer);
	state.timer = null;
	state.validator = null;
	state.accessValidator = null;
	state.checking = false;
}
