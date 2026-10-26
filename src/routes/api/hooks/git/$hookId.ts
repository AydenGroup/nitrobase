import { createFileRoute } from "@tanstack/react-router";
import { handleGitWebhook } from "#/features/git/webhook.server.ts";

/**
 * Push webhook of a git app. Unauthenticated by design: the request is
 * verified with the app's webhook secret (HMAC or token, per provider);
 * see `handleGitWebhook` for the rate limits, replay and existence rules.
 */
export const Route = createFileRoute("/api/hooks/git/$hookId")({
	server: {
		handlers: {
			POST: async ({ request, params }) =>
				handleGitWebhook(request, params.hookId),
		},
	},
});
