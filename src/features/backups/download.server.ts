import { z } from "zod";
import { destinationCapabilities } from "#/config/backup-drivers.ts";
import { getConfig } from "#/config/server.ts";
import type { Actor } from "#/features/auth/access.ts";
import { getBackupRow } from "#/features/backups/backups.server.ts";
import {
	getDestinationRow,
	pickServer,
} from "#/features/backups/destinations.server.ts";
import { newWorkDir, openRclone } from "#/features/backups/rclone.server.ts";
import { getExecutor } from "#/features/servers/servers.server.ts";
import { audit } from "#/server/services/audit.ts";
import { AppError, internalError } from "#/utils/error.ts";

/**
 * Download a backup archive (HTTP handler body of
 * `/api/backups/$backupId/download`): streamed from the destination
 * through the server that can reach it (`rclone cat`), never stored on the
 * panel. The route checks backup.download; access to the row is checked
 * here (instance.manage for panel backups); audited.
 */
export async function backupDownloadResponse(
	actor: Actor,
	backupIdParam: string,
	request: Request,
): Promise<Response> {
	const id = z.guid().safeParse(backupIdParam);
	if (!id.success) {
		return Response.json({ message: "Bad request" }, { status: 400 });
	}
	let backup: Awaited<ReturnType<typeof getBackupRow>>;
	try {
		backup = await getBackupRow(actor, id.data);
	} catch (error) {
		if (error instanceof AppError) {
			return Response.json({ message: "Not found" }, { status: 404 });
		}
		throw error;
	}
	if (backup.status !== "success" || !backup.path) {
		return Response.json({ message: "Backup has no archive" }, { status: 409 });
	}
	const destination = await getDestinationRow(actor, backup.destinationId);
	const server = await pickServer(
		actor,
		destinationCapabilities(destination.type).onServer
			? (backup.serverId ?? undefined)
			: undefined,
	);
	const executor = await getExecutor(server);
	let session: Awaited<ReturnType<typeof openRclone>>;
	try {
		session = await openRclone(executor, destination, newWorkDir("download"));
	} catch (error) {
		executor.close();
		throw error;
	}
	audit({
		actor,
		action: "backup.download",
		targetType: "backup",
		targetId: backup.id,
	});
	const abort = new AbortController();
	request.signal.addEventListener("abort", () => abort.abort());
	const path = backup.path;
	const config = getConfig();
	const highWaterMark = config.BACKUP_DOWNLOAD_BUFFER_BYTES;
	// Idle-based: only cut a download when nothing moves (no bytes
	// from the destination and none read by the client) for a while.
	let lastProgress = Date.now();
	let idleTimer: ReturnType<typeof setInterval> | null = null;
	let flow: { pause: () => void; resume: () => void } | null = null;
	let paused = false;
	const body = new ReadableStream<Uint8Array>(
		{
			start(controller) {
				let closed = false;
				idleTimer = setInterval(
					() => {
						if (
							Date.now() - lastProgress >
							config.BACKUP_DOWNLOAD_IDLE_TIMEOUT_MS
						) {
							closed = true;
							abort.abort();
							try {
								controller.error(internalError("download idle timeout"));
							} catch {
								// already closed
							}
						}
					},
					Math.min(
						config.BACKUP_DOWNLOAD_IDLE_CHECK_MS,
						config.BACKUP_DOWNLOAD_IDLE_TIMEOUT_MS,
					),
				);
				session
					.run(["cat", session.remotePath(path)], {
						onFlowControl: (control) => {
							flow = control;
						},
						onStdoutData: (chunk) => {
							if (closed) return;
							lastProgress = Date.now();
							try {
								controller.enqueue(new Uint8Array(chunk));
							} catch {
								closed = true;
								abort.abort();
								return;
							}
							// Slow client: stop reading until pull() asks again.
							if ((controller.desiredSize ?? 1) <= 0 && !paused) {
								paused = true;
								flow?.pause();
							}
						},
						discardOutput: true,
						signal: abort.signal,
						timeoutMs: config.BACKUP_DOWNLOAD_TIMEOUT_MS,
					})
					.then((result) => {
						if (closed) return;
						closed = true;
						if (result.exitCode !== 0) {
							controller.error(internalError("download failed"));
						} else {
							controller.close();
						}
					})
					.catch((error) => {
						if (!closed) controller.error(error);
					})
					.finally(() => {
						if (idleTimer) clearInterval(idleTimer);
						// Remove the staging dir (credentials) before closing SSH.
						void session
							.close()
							.catch(() => undefined)
							.finally(() => executor.close());
					});
			},
			pull() {
				lastProgress = Date.now();
				if (paused) {
					paused = false;
					flow?.resume();
				}
			},
			cancel() {
				if (idleTimer) clearInterval(idleTimer);
				abort.abort();
			},
		},
		new ByteLengthQueuingStrategy({ highWaterMark }),
	);
	const name = path.split("/").pop() ?? "backup";
	return new Response(body, {
		headers: {
			"Content-Type": "application/octet-stream",
			"Content-Disposition": `attachment; filename="${name.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
			...(backup.sizeBytes
				? { "Content-Length": String(backup.sizeBytes) }
				: {}),
		},
	});
}
