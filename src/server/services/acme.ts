import { getConfig } from "#/config/server.ts";
import { AppError } from "#/utils/error.ts";

/**
 * Let's Encrypt rejects placeholder domains like example.com, so prefer an
 * explicit ACME_EMAIL and fall back to the admin's account email.
 */
export function getAcmeEmail(userEmail?: string): string {
	const email = getConfig().ACME_EMAIL || userEmail;
	if (!email) {
		throw new AppError("ACME_EMAIL_REQUIRED");
	}
	return email;
}
