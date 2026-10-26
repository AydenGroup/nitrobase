import { asBytes, type ErrorInfo } from "#/libs/coded.ts";
import { coded } from "#/utils/error.ts";

/**
 * Checks every provider's preflight shares (pure). Provider-specific
 * analysis lives next to its driver (e.g. `supabase-preflight.ts`).
 */

/** Blocks when the target has less free disk than the copy needs. */
export function diskBlocker(
	requiredDiskBytes: number,
	freeDiskBytes: number | null,
): ErrorInfo | null {
	return freeDiskBytes !== null && freeDiskBytes < requiredDiskBytes
		? coded("CLOUD_SYNC_DISK_LOW", {
				required: asBytes(requiredDiskBytes),
				free: asBytes(freeDiskBytes),
			})
		: null;
}
