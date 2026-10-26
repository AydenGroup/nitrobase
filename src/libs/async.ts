/** Resolves after `ms` milliseconds (client-safe). */
export const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));
