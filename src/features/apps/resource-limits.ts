const MIB = 1024 * 1024;

export interface LowMemoryLimit {
	service: string;
	/** The limit being set (MiB). */
	limitMb: number;
	/** What the service uses now (MiB, rounded up). */
	usedMb: number;
}

/**
 * Services whose memory limit is below what they use now: the next
 * redeploy applies the limit and the kernel kills them (out of memory).
 * A service without a limit or without a usage sample is never listed.
 */
export function lowMemoryLimits(
	limits: Record<string, { memoryMb: number | null }>,
	usage: { service: string; memUsed: number | null }[],
): LowMemoryLimit[] {
	const used = new Map(usage.map((item) => [item.service, item.memUsed]));
	const low: LowMemoryLimit[] = [];
	for (const [service, { memoryMb }] of Object.entries(limits)) {
		const memUsed = used.get(service);
		if (!memoryMb || memUsed === null || memUsed === undefined) continue;
		if (memoryMb * MIB < memUsed) {
			low.push({
				service,
				limitMb: memoryMb,
				usedMb: Math.ceil(memUsed / MIB),
			});
		}
	}
	return low;
}
