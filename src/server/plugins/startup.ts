import { definePlugin } from "nitro";
import { getConfig } from "#/config/server.ts";
import { stopMonitoring } from "#/features/monitoring/service.server.ts";
import { checkInstanceIdentity } from "#/features/settings/instance-identity.server.ts";
import { startBackgroundWork } from "#/server/background.ts";
import { stopScheduler } from "#/server/services/scheduler.ts";
import { assertServerEnv } from "#/utils/env.ts";

/**
 * Boot hook (assumes a single app instance: jobs, locks and the scheduler
 * are in-process). Validates config, then starts background work, unless
 * the database belongs to another instance (restored/cloned): then it
 * stays paused until an instance admin resumes (instance-state.ts).
 */
export default definePlugin((nitroApp) => {
	// Refuse to start with missing/weak secrets instead of failing per request.
	assertServerEnv();
	getConfig();

	// Until the check succeeds (e.g. the DB is still starting) nothing runs
	// in the background: retried, never assumed.
	const boot = (attempt: number) => {
		void checkInstanceIdentity()
			.then((paused) => {
				if (!paused) startBackgroundWork();
			})
			.catch((error) => {
				console.error("[startup] instance identity check failed", error);
				const config = getConfig();
				setTimeout(
					() => boot(attempt + 1),
					Math.min(
						config.STARTUP_RETRY_MAX_MS,
						config.STARTUP_RETRY_BASE_MS * 2 ** attempt,
					),
				);
			});
	};
	boot(0);

	nitroApp.hooks.hook("close", async () => {
		stopScheduler();
		await stopMonitoring().catch((error) =>
			console.error("[startup] failed to stop monitoring", error),
		);
	});
});
