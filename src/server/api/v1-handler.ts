import { appBaseUrl } from "#/config/server.ts";
import { deploymentStreamResponse } from "#/features/deployments/stream.server.ts";
import { getDeployment } from "#/features/servers/servers.server.ts";
import { authenticateBearer } from "./bearer";
import {
	type ApiFailure,
	apiErrorFailure,
	prepareApiCall,
	runApiRoute,
} from "./run";
import { matchApiRoute, openApiDocument } from "./v1";

/**
 * `/api/v1/*`: the bearer-token REST surface. Every operation comes from
 * the registry in #/server/api/v1.ts, which names its permission; this
 * route authenticates the token and rate-limits (./bearer.ts), then checks
 * the permission, validates input with the entry's zod schemas and maps
 * errors to HTTP (./run.ts, shared with the MCP server). Bearer calls are
 * audited through the actions they perform (tagged with the token id).
 */

const json = (status: number, body: unknown) => Response.json(body, { status });

const failed = (outcome: ApiFailure) => json(outcome.status, outcome.body);

async function readJsonBody(request: Request) {
	if (request.method !== "POST") return { ok: true as const, value: {} };
	const text = await request.text();
	if (!text.trim()) return { ok: true as const, value: {} };
	try {
		return { ok: true as const, value: JSON.parse(text) as unknown };
	} catch {
		return {
			ok: false as const,
			status: 400,
			body: { error: "bad_request", message: "Invalid JSON body" },
		};
	}
}

/** Handle one `/api/v1/<splat>` request. */
export async function handleApiRequest(
	request: Request,
	splat: string,
): Promise<Response> {
	const url = new URL(request.url);
	const path = `/${splat}`.replace(/\/+$/, "") || "/";
	if (request.method === "GET" && path === "/openapi.json") {
		const base = appBaseUrl() ?? url.origin;
		return json(200, openApiDocument(base));
	}

	const actor = await authenticateBearer(request, { path, channel: "api" });
	if (actor instanceof Response) return actor;

	const matched = matchApiRoute(request.method, path);
	if (matched === "method") return json(405, { error: "method_not_allowed" });
	if (!matched) return json(404, { error: "not_found" });
	const { route } = matched;
	const input = { params: matched.params, body: () => readJsonBody(request) };
	const label = `${request.method} ${path}`;

	if (route.stream) {
		const prepared = await prepareApiCall(actor, route, input);
		if (!prepared.ok) return failed(prepared);
		try {
			const jobId = (prepared.params as { jobId: string }).jobId;
			await getDeployment(actor, jobId);
			return deploymentStreamResponse(actor, jobId, request, {
				permission: route.permission,
				coded: false,
			});
		} catch (error) {
			return failed(apiErrorFailure(error, request, label));
		}
	}
	const outcome = await runApiRoute(actor, route, input, request, label);
	return outcome.ok ? json(200, outcome.value) : failed(outcome);
}
