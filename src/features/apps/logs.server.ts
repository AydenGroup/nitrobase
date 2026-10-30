import { z } from "zod";
import { getConfig } from "#/config/server.ts";
import {
	appLocation,
	appSecretValues,
	deployedServices,
	getAppRow,
	getAppServer,
} from "#/features/apps/apps.server.ts";
import type { Actor } from "#/features/auth/access.ts";
import {
	liveConnectionOf,
	liveSessionSignal,
} from "#/features/auth/sessions.server.ts";
import { getExecutor } from "#/features/servers/servers.server.ts";
import { splitLogChunk } from "#/libs/job-log.ts";
import { composeLogsCommand } from "#/server/services/apps/commands.ts";
import { createSseStream, sseResponse } from "#/server/services/sse.ts";
import { createSecretMasker } from "#/server/services/tasks/commands.ts";
import { AppError } from "#/utils/error.ts";

/**
 * Container logs of an app (HTTP handler body of `/api/apps/$appId/logs`):
 * `?service=&tail=` streams `docker compose logs -f` as SSE; `&download=1`
 * returns the last `tail` lines as a text file. Live streams per user are
 * capped (each holds an SSH channel).
 */

const QuerySchema = z.object({
	service: z
		.string()
		.regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/)
		.optional(),
	tail: z.coerce.number().int().min(0).optional(),
	download: z.enum(["1"]).optional(),
	timestamps: z.enum(["0", "1"]).optional(),
});

const activeStreams = new Map<string, number>();

/** One more live stream for `userId`; null when the cap is reached. */
function takeStreamSlot(userId: string): (() => void) | null {
	const active = activeStreams.get(userId) ?? 0;
	if (active >= getConfig().APP_LOG_STREAMS_PER_USER) return null;
	activeStreams.set(userId, active + 1);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		const count = (activeStreams.get(userId) ?? 1) - 1;
		if (count <= 0) activeStreams.delete(userId);
		else activeStreams.set(userId, count);
	};
}

export async function appLogsResponse(
	actor: Actor,
	userId: string,
	appIdParam: string,
	request: Request,
): Promise<Response> {
	const appId = z.guid().safeParse(appIdParam);
	const url = new URL(request.url);
	const query = QuerySchema.safeParse(Object.fromEntries(url.searchParams));
	if (!appId.success || !query.success) {
		return Response.json({ message: "Bad request" }, { status: 400 });
	}
	let app: Awaited<ReturnType<typeof getAppRow>>;
	try {
		app = await getAppRow(actor, appId.data);
	} catch (error) {
		if (error instanceof AppError) {
			return Response.json({ message: "App not found" }, { status: 404 });
		}
		throw error;
	}
	const { service, download } = query.data;
	const timestamps = query.data.timestamps !== "0";
	if (service && !deployedServices(app).includes(service)) {
		return Response.json({ message: "Unknown service" }, { status: 400 });
	}
	const config = getConfig();
	const tail = Math.min(
		query.data.tail ?? config.APP_LOGS_TAIL_DEFAULT,
		config.APP_LOGS_TAIL_MAX,
	);
	const location = appLocation(app);
	// The log is the app's own output: a secret it prints is masked like in
	// task and build output, so a viewer cannot read it here.
	const masker = createSecretMasker(await appSecretValues(app));

	if (download) {
		const executor = await getExecutor(await getAppServer(app));
		try {
			const result = await executor.exec(
				composeLogsCommand(location, {
					service,
					tail,
					follow: false,
					timestamps,
				}),
			);
			const name = `${app.folder}${service ? `-${service}` : ""}.log`;
			const text = `${result.stdout}\n${result.stderr}`;
			return new Response(masker.push(text) + masker.flush(), {
				headers: {
					"Content-Type": "text/plain; charset=utf-8",
					"Content-Disposition": `attachment; filename="${name}"`,
				},
			});
		} finally {
			executor.close();
		}
	}

	const release = takeStreamSlot(userId);
	if (!release) {
		return Response.json(
			{ message: "Too many open log streams" },
			{ status: 429 },
		);
	}
	let executor: Awaited<ReturnType<typeof getExecutor>>;
	try {
		executor = await getExecutor(await getAppServer(app));
	} catch (error) {
		release();
		throw error;
	}
	// Ends when the client goes away or the session is revoked.
	const live = liveSessionSignal(
		liveConnectionOf(actor, "app.view"),
		request.signal,
	);
	const abort = new AbortController();
	const stream = createSseStream({
		signal: live.signal,
		start(channel) {
			channel.onClose(() => {
				abort.abort();
				live.release();
				release();
			});
			let pending = "";
			const onChunk = (chunk: string) => {
				const { lines, rest } = splitLogChunk(pending, masker.push(chunk));
				pending = rest;
				for (const line of lines) channel.event("log", line);
			};
			executor
				.exec(
					composeLogsCommand(location, {
						service,
						tail,
						follow: true,
						timestamps,
					}),
					{
						onStdout: onChunk,
						onStderr: onChunk,
						signal: abort.signal,
						discardOutput: true,
						timeoutMs: config.APP_LOG_STREAM_MAX_MS,
					},
				)
				.then((result) => {
					const last = pending + masker.flush();
					if (last) channel.event("log", last);
					channel.event("end", { exitCode: result.exitCode });
				})
				.catch((error) =>
					channel.event("failure", {
						message: error instanceof Error ? error.message : String(error),
					}),
				)
				.finally(() => {
					executor.close();
					channel.close();
				});
		},
	});
	return sseResponse(stream);
}
