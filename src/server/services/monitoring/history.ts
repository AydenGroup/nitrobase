/**
 * Storage resolution rules: raw samples for METRICS_RAW_RETENTION_HOURS,
 * then rollups (averages per METRICS_ROLLUP_BUCKET_MINUTES) for
 * METRICS_ROLLUP_RETENTION_DAYS. Pure so they can be tested.
 */

export interface ResolutionSettings {
	intervalSeconds: number;
	rawRetentionSeconds: number;
	rollupBucketSeconds: number;
	rollupRetentionSeconds: number;
	/** Target points per chart series. */
	points: number;
}

export interface HistoryPlan {
	/** Rows to read: 0 = raw samples, else the rollup bucket width. */
	bucketSeconds: number;
	/** Chart bin width (multiple of the source resolution). */
	binSeconds: number;
	from: Date;
	to: Date;
}

/**
 * Which rows answer a history query over the last `rangeSeconds`: raw when
 * they still cover the whole range, rollups otherwise. Bins are widened so
 * a series has at most `points` points.
 */
export function historyPlan(
	rangeSeconds: number,
	now: Date,
	settings: ResolutionSettings,
): HistoryPlan {
	const raw = rangeSeconds <= settings.rawRetentionSeconds;
	const resolution = raw
		? Math.max(1, settings.intervalSeconds)
		: settings.rollupBucketSeconds;
	const wanted = Math.ceil(rangeSeconds / Math.max(1, settings.points));
	const binSeconds = Math.max(
		resolution,
		Math.ceil(wanted / resolution) * resolution,
	);
	return {
		bucketSeconds: raw ? 0 : settings.rollupBucketSeconds,
		binSeconds,
		from: new Date(now.getTime() - rangeSeconds * 1000),
		to: now,
	};
}

/** Rows older than these are deleted. */
export function retentionCutoffs(
	now: Date,
	settings: Pick<
		ResolutionSettings,
		"rawRetentionSeconds" | "rollupRetentionSeconds"
	>,
): { raw: Date; rollup: Date } {
	return {
		raw: new Date(now.getTime() - settings.rawRetentionSeconds * 1000),
		rollup: new Date(now.getTime() - settings.rollupRetentionSeconds * 1000),
	};
}

/** Start of the bucket containing `date` (epoch aligned). */
export function bucketStart(date: Date, bucketSeconds: number): Date {
	const ms = bucketSeconds * 1000;
	return new Date(Math.floor(date.getTime() / ms) * ms);
}

/**
 * Raw rows to (re-)aggregate: complete buckets in the last `lookbackSeconds`
 * (the current, still filling bucket is excluded). Upserts make re-running
 * a window harmless and pick up rows written late by the batch writer.
 */
export function rollupWindow(
	now: Date,
	bucketSeconds: number,
	lookbackSeconds: number,
): { from: Date; to: Date } | null {
	const to = bucketStart(now, bucketSeconds);
	const from = bucketStart(
		new Date(now.getTime() - lookbackSeconds * 1000),
		bucketSeconds,
	);
	return from < to ? { from, to } : null;
}
