/**
 * Buffers rows and writes them in batches: when `maxRows` are queued or
 * every `intervalMs`. A failed write is logged and its rows are dropped
 * (metrics are best effort; retrying could grow the buffer without bound).
 * Flushes never overlap.
 */
export function createBatchWriter<T>(options: {
	write: (rows: T[]) => Promise<void>;
	maxRows: number;
	intervalMs: number;
	onError?: (error: unknown) => void;
}) {
	let buffer: T[] = [];
	let running: Promise<void> | null = null;
	let timer: ReturnType<typeof setInterval> | null = null;

	const flush = async (): Promise<void> => {
		if (running) await running;
		if (buffer.length === 0) return;
		const rows = buffer;
		buffer = [];
		running = options
			.write(rows)
			.catch((error) => options.onError?.(error))
			.finally(() => {
				running = null;
			});
		await running;
	};

	return {
		add(rows: T[]): void {
			if (rows.length === 0) return;
			buffer.push(...rows);
			if (!timer) {
				timer = setInterval(() => void flush(), options.intervalMs);
				timer.unref?.();
			}
			if (buffer.length >= options.maxRows) void flush();
		},
		flush,
		get size() {
			return buffer.length;
		},
		/** Write what is left and stop the timer. */
		async stop(): Promise<void> {
			if (timer) clearInterval(timer);
			timer = null;
			await flush();
		},
	};
}
