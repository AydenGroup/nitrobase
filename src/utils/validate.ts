/**
 * Maps a server-side ZodError (its message is the JSON issue list) to Mantine
 * form errors keyed by the last path segment. Keeps the first issue per field.
 */
export function issuesToFormErrors(error: unknown): Record<string, string> {
	const message = error instanceof Error ? error.message : String(error);

	try {
		const issues = JSON.parse(message);
		if (!Array.isArray(issues)) return {};

		const result: Record<string, string> = {};
		for (const issue of issues) {
			if (Array.isArray(issue.path) && issue.path.length > 0 && issue.message) {
				const field = String(issue.path[issue.path.length - 1]);
				if (!result[field]) result[field] = issue.message;
			}
		}
		return result;
	} catch {
		return {};
	}
}

/**
 * Detects a ZodError after server-function serialization, where it arrives
 * as a plain Error whose message is the JSON array of issues.
 */
export const isZodError = (error: unknown): boolean => {
	if (!(error instanceof Error)) return false;
	try {
		const parsed = JSON.parse(error.message);
		return Array.isArray(parsed) && parsed.length > 0 && "path" in parsed[0];
	} catch {
		return false;
	}
};
