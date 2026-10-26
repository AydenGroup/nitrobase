/**
 * Tiny in-process event bus for alert transitions. Phase K notification
 * channels subscribe here; listeners run after the alert row is written.
 * Errors are logged, never thrown into the collection loop. Kept on
 * globalThis so dev HMR reloads don't drop or duplicate subscribers.
 */

export interface AlertEvent {
	type: "opened" | "resolved";
	alert: {
		id: string;
		teamId: string;
		serverId: string;
		appId: string | null;
		rule: string;
		subject: string;
		severity: string;
		value: number | null;
		threshold: number | null;
		openedAt: Date;
		resolvedAt: Date | null;
	};
}

export type AlertListener = (event: AlertEvent) => Promise<void> | void;

const globalBus = globalThis as typeof globalThis & {
	__nitrobaseAlertListeners?: Set<AlertListener>;
};
globalBus.__nitrobaseAlertListeners ??= new Set();
const listeners = globalBus.__nitrobaseAlertListeners;

export function onAlert(listener: AlertListener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export async function emitAlert(event: AlertEvent): Promise<void> {
	for (const listener of [...listeners]) {
		try {
			await listener(event);
		} catch (error) {
			console.error("[alerts] listener failed", error);
		}
	}
}
