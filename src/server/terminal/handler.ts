import type { I18n } from "@lingui/core";
import { defineWebSocketHandler } from "h3";
import type { AuditActionId } from "#/config/audit-actions.ts";
import type { Permission } from "#/config/permissions.ts";
import { getConfig } from "#/config/server.ts";
import { APP_ID } from "#/config/shared.ts";
import { type Actor, can } from "#/features/auth/access.ts";
import { trackLiveConnection } from "#/features/auth/sessions.server.ts";
import {
	recordTerminalEnd,
	recordTerminalStart,
} from "#/features/deployments/deployments.server.ts";
import type { ServerRow } from "#/features/servers/schema.ts";
import { getExecutor } from "#/features/servers/servers.server.ts";
import {
	memberActor,
	resolveSessionActor,
} from "#/features/teams/membership.server.ts";
import {
	DEFAULT_COLS,
	DEFAULT_ROWS,
	isSameOriginUpgrade,
	MAX_INPUT_BYTES,
	parseTerminalMessage,
} from "#/libs/terminal.ts";
import { type AuditEvent, audit } from "#/server/services/audit.ts";
import type { SessionEndedError } from "#/server/services/auth/live-connections.ts";
import type { Executor, ShellSession } from "#/server/services/executor.ts";
import {
	isLocale,
	localeFromCookieHeader,
	serverI18n,
} from "#/server/services/i18n.ts";
import {
	type RequestInfo,
	requestInfoFrom,
} from "#/server/services/request-info.ts";
import { getSessionFromCookie } from "#/server/services/session";
import {
	AppError,
	getAppErrorMessage,
	toolOutputError,
} from "#/utils/error.ts";

/** What a terminal endpoint resolves for an authorized request. */
export interface TerminalTarget {
	server: ServerRow;
	/** Trusted command to run in a PTY; omitted = host shell. */
	command?: string;
	appId?: string;
	auditAction: AuditActionId;
	auditCloseAction: AuditActionId;
	auditTarget: { type: "server" | "app"; id: string };
	/** First line shown while the shell connects, in the viewer's locale. */
	greeting: (i18n: I18n) => string;
}

export interface TerminalEndpoint {
	pathPattern: RegExp;
	/** Permission the caller's role must grant (checked at upgrade and open). */
	permission: Permission;
	/**
	 * Resolve the target for `actor` (team checked here). Return a Response
	 * to reject. Called at upgrade and again at open.
	 */
	resolve(
		actor: Actor,
		match: RegExpMatchArray,
		url: URL,
	): Promise<TerminalTarget | Response>;
}

type PeerContext = {
	userId: string;
	sessionId: string;
	/** Team the terminal was opened in (the active team at upgrade). */
	teamId: string;
	url: string;
	request: RequestInfo;
	/** Locale of the viewer (cookie), for the `[nitrobase]` banners. */
	locale?: string;
};

type TerminalState = {
	closed: boolean;
	auditId: Promise<string | null>;
	idleTimer: ReturnType<typeof setTimeout> | null;
	/** Why the session ended (AppError, stored on the job row). */
	endReason: AppError | null;
	resetIdle?: () => void;
	executor: Executor | null;
	session: ShellSession | null;
	ready: Promise<ShellSession | null>;
	/** Set once the terminal opened (audited again on close). */
	closeAudit: Omit<AuditEvent, "meta"> | null;
	/** Stops tracking the socket under its session. */
	untrack: () => void;
	i18n: I18n;
};

/** A `[<app id>]` status line written into the terminal between output. */
function banner(text: string): string {
	return `\r\n[${APP_ID}] ${text}\r\n`;
}

function sessionEndedMessage(i18n: I18n, error: SessionEndedError): string {
	return error.reason === "expired"
		? i18n._("Your session expired. Sign in again.")
		: error.reason === "forbidden"
			? i18n._("Your access in this team changed. Reload the page.")
			: i18n._("Your session was signed out. Sign in again.");
}

/** Locale of the banners: the page's `?locale=`, else the locale cookie. */
function pageLocale(url: URL, headers: Headers): string | undefined {
	const requested = url.searchParams.get("locale");
	if (isLocale(requested)) return requested;
	return localeFromCookieHeader(headers.get("cookie") ?? "");
}

function teardown(state: TerminalState) {
	state.untrack();
	if (state.idleTimer) clearTimeout(state.idleTimer);
	state.idleTimer = null;
	try {
		state.session?.close();
	} catch {
		// ignore
	}
	state.executor?.close();
	state.session = null;
	state.executor = null;
}

/**
 * WebSocket terminal shared by host and container terminals: origin check,
 * cookie auth, ownership via `resolve`, idle timeout, audit + session row,
 * no leaked sessions when the socket closes while connecting.
 */
export function createTerminalHandler(endpoint: TerminalEndpoint) {
	const terminals = new Map<string, TerminalState>();

	return defineWebSocketHandler({
		async upgrade(request) {
			const url = new URL(request.url);
			const match = url.pathname.match(endpoint.pathPattern);
			if (!match) throw new Response("Not found", { status: 404 });
			if (!isSameOriginUpgrade(request.headers)) {
				throw new Response("Forbidden", { status: 403 });
			}
			const session = await getSessionFromCookie(
				request.headers.get("cookie") ?? "",
			);
			if (!session) throw new Response("Unauthorized", { status: 401 });
			const { userId, sessionId } = session;
			const actor = await resolveSessionActor(session);
			if (!actor || !can(actor, endpoint.permission)) {
				throw new Response("Forbidden", { status: 403 });
			}
			const target = await endpoint.resolve(actor, match, url);
			if (target instanceof Response) throw target;
			return {
				context: {
					userId,
					sessionId,
					teamId: actor.teamId,
					url: url.toString(),
					request: requestInfoFrom(request),
					// The page passes its locale (`?locale=`); the cookie is a fallback.
					locale: pageLocale(url, request.headers),
				},
			};
		},

		open(peer) {
			const {
				userId,
				sessionId,
				teamId,
				url: rawUrl,
				request,
				locale,
			} = peer.context as PeerContext;
			const i18n = serverI18n(locale);
			if (!userId || !sessionId || !teamId || !rawUrl) {
				peer.close();
				return;
			}
			const url = new URL(rawUrl);
			const match = url.pathname.match(endpoint.pathPattern);
			const state: TerminalState = {
				closed: false,
				auditId: Promise.resolve(null),
				idleTimer: null,
				endReason: null,
				executor: null,
				session: null,
				ready: Promise.resolve(null),
				closeAudit: null,
				untrack: () => {},
				i18n,
			};
			terminals.set(peer.id, state);
			// Revoking the session (or it expiring) ends the shell right away.
			state.untrack = trackLiveConnection({
				sessionId,
				userId,
				// Leaving the team or losing the permission also ends the shell.
				access: { teamId, permission: endpoint.permission },
				close: (error) => {
					state.endReason = new AppError(
						error.reason === "forbidden"
							? "TERMINAL_ACCESS_CHANGED"
							: "TERMINAL_SESSION_ENDED",
					);
					try {
						peer.send(banner(sessionEndedMessage(i18n, error)));
					} finally {
						teardown(state);
						// 4403: access in the team changed; 4401: session ended.
						if (error.reason === "forbidden") {
							peer.close(4403, "access changed");
						} else {
							peer.close(4401, "session ended");
						}
					}
				},
			});

			state.resetIdle = () => {
				if (state.idleTimer) clearTimeout(state.idleTimer);
				state.idleTimer = setTimeout(() => {
					state.endReason = new AppError("TERMINAL_IDLE");
					try {
						peer.send(
							banner(i18n._("Session closed after being idle too long.")),
						);
					} finally {
						peer.close();
					}
				}, getConfig().TERMINAL_IDLE_TIMEOUT_MS);
			};
			state.resetIdle();

			state.ready = (async () => {
				try {
					if (!match) throw new AppError("NOT_FOUND");
					const actor = await memberActor(userId, teamId, {
						via: "session",
						sessionId,
					});
					if (!actor || !can(actor, endpoint.permission)) {
						throw new AppError("TERMINAL_NO_ACCESS");
					}
					const target = await endpoint.resolve(actor, match, url);
					if (target instanceof Response) {
						throw toolOutputError(await target.text());
					}
					state.auditId = recordTerminalStart(
						actor,
						target.server.id,
						target.appId,
					).catch(() => null);
					audit({
						actor,
						action: target.auditAction,
						targetType: target.auditTarget.type,
						targetId: target.auditTarget.id,
						request,
					});
					state.closeAudit = {
						actor,
						action: target.auditCloseAction,
						targetType: target.auditTarget.type,
						targetId: target.auditTarget.id,
						request,
					};

					peer.send(banner(target.greeting(i18n)));
					state.executor = await getExecutor(target.server);
					if (state.closed) {
						teardown(state);
						return null;
					}
					const session = await state.executor.shell({
						cols: DEFAULT_COLS,
						rows: DEFAULT_ROWS,
						command: target.command,
						onData: (data) => {
							try {
								peer.send(data);
							} catch {
								teardown(state);
							}
						},
						onClose: () => {
							try {
								peer.close();
							} catch {
								// ignore
							}
						},
						onError: (err) => {
							try {
								peer.send(
									banner(
										i18n._("Terminal error: {message}", {
											message: err.message,
										}),
									),
								);
							} finally {
								peer.close();
							}
						},
					});
					state.session = session;
					// The socket closed while we were connecting: don't leak the shell.
					if (state.closed) {
						teardown(state);
						return null;
					}
					return session;
				} catch (error) {
					teardown(state);
					try {
						peer.send(banner(getAppErrorMessage(i18n, error)));
					} finally {
						peer.close();
					}
					return null;
				}
			})();
		},

		async message(peer, message) {
			const state = terminals.get(peer.id);
			if (!state) return;
			let text: string;
			try {
				text = message.text();
			} catch {
				return;
			}
			const parsed = parseTerminalMessage(text);
			if (!parsed) return;
			if (parsed.kind === "rejected") {
				// Clients chunk input below the limit; anything bigger is dropped
				// whole (never half-applied) and the user sees why.
				try {
					peer.send(
						banner(
							state.i18n._(
								"Input of {size} characters was dropped: the limit per message is {limit}.",
								{ size: parsed.size, limit: MAX_INPUT_BYTES },
							),
						),
					);
				} catch {
					// socket already gone
				}
				return;
			}
			if (parsed.kind !== "resize") state.resetIdle?.();

			// Input typed while the shell is still connecting is delivered once ready.
			const session = state.session ?? (await state.ready);
			if (!session || state.closed) return;
			if (parsed.kind === "input" || parsed.kind === "raw") {
				session.write(parsed.data);
			} else {
				session.resize(parsed.rows, parsed.cols);
			}
		},

		close(peer) {
			const state = terminals.get(peer.id);
			terminals.delete(peer.id);
			if (!state) return;
			state.closed = true;
			teardown(state);
			if (state.closeAudit) {
				audit({
					...state.closeAudit,
					meta: { reason: state.endReason?.code ?? "closed" },
				});
			}
			void state.auditId.then((id) =>
				id ? recordTerminalEnd(id, state.endReason).catch(() => {}) : undefined,
			);
		},
	});
}
