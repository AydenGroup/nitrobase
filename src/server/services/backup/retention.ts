/**
 * Retention: a successful backup is kept when it is one of the newest
 * `keepLast`, or younger than `keepDays`. With neither rule, everything is
 * kept. Failed/running rows are never selected (they have no archive to
 * prune; failed rows are cleaned with their policy). Pure.
 */
export interface RetentionRule {
	keepLast: number | null;
	keepDays: number | null;
}

export interface RetentionCandidate {
	id: string;
	createdAt: Date;
	status: string;
}

export function selectExpired<T extends RetentionCandidate>(
	backups: T[],
	rule: RetentionRule,
	now: Date,
): T[] {
	if (rule.keepLast === null && rule.keepDays === null) return [];
	const done = backups
		.filter((backup) => backup.status === "success")
		.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
	const cutoff =
		rule.keepDays === null
			? null
			: now.getTime() - rule.keepDays * 24 * 60 * 60 * 1000;
	return done.filter((backup, index) => {
		const byCount = rule.keepLast !== null && index < rule.keepLast;
		const byAge = cutoff !== null && backup.createdAt.getTime() >= cutoff;
		// Never prune the newest successful backup.
		return index > 0 && !byCount && !byAge;
	});
}
