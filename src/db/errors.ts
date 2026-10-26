/** Postgres SQLSTATE of a driver error, also when wrapped by Drizzle (`cause`). */
function sqlState(error: unknown): string | undefined {
	return (
		(error as { code?: string })?.code ??
		(error as { cause?: { code?: string } })?.cause?.code
	);
}

/** Postgres unique violation (e.g. `domains.host` or a user email taken). */
export function isUniqueViolation(error: unknown): boolean {
	return sqlState(error) === "23505";
}

/** Postgres foreign key violation (e.g. a row still referenced elsewhere). */
export function isForeignKeyViolation(error: unknown): boolean {
	return sqlState(error) === "23503";
}
