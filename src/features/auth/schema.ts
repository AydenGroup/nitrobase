import type { I18n } from "@lingui/core";
import { z } from "zod";
import { isAllowedAvatarUrl } from "#/config/avatars.ts";
import { AVATAR_URL_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "#/config/shared.ts";
import type { users } from "#/db/schema/user";
import { emailSchema } from "#/libs/email.ts";

/**
 * Zod schemas are factories taking the active `I18n` so validation messages
 * are localized; the same schema validates on the client form and server.
 */
export const LoginSchema = (i18n: I18n) =>
	z.object({
		email: emailSchema({ message: i18n._("Invalid email address") }),
		// No length rule on login: existing accounts may predate the policy.
		password: z.string().min(1, { message: i18n._("Password is required") }),
		rememberMe: z.boolean().optional(),
	});

/** First-admin registration; `confirmPassword` must equal `password`. */
export const RegisterSchema = (i18n: I18n) =>
	z
		.object({
			firstName: z
				.string()
				.min(1, { message: i18n._("First name is required") }),
			lastName: z.string().min(1, { message: i18n._("Last name is required") }),
			email: emailSchema({ message: i18n._("Invalid email address") }),
			password: z.string().min(PASSWORD_MIN_LENGTH, {
				message: i18n._("Password must be at least {min} characters", {
					min: PASSWORD_MIN_LENGTH,
				}),
			}),
			confirmPassword: z.string().min(1, {
				message: i18n._("Please confirm your password"),
			}),
			/** First account only: SETUP_TOKEN, or the one printed in the logs. */
			setupToken: z.string().trim().max(256).optional(),
		})
		.refine((data) => data.password === data.confirmPassword, {
			message: i18n._("Passwords do not match"),
			path: ["confirmPassword"],
		});

/**
 * Profile update. `currentPassword` is always required; an empty
 * `newPassword` keeps the existing password.
 */
export const UpdateProfileSchema = (i18n: I18n) =>
	z
		.object({
			firstName: z
				.string()
				.min(1, { message: i18n._("First name is required") }),
			lastName: z.string().min(1, { message: i18n._("Last name is required") }),
			email: emailSchema({ message: i18n._("Invalid email address") }),
			currentPassword: z.string().min(1, {
				message: i18n._("Current password is required to save changes"),
			}),
			newPassword: z
				.string()
				.min(PASSWORD_MIN_LENGTH, {
					message: i18n._("Password must be at least {min} characters", {
						min: PASSWORD_MIN_LENGTH,
					}),
				})
				.optional()
				.or(z.literal("")),
			// Initials (""), a generated avatar on this origin, or https only.
			avatarUrl: z
				.string()
				.trim()
				.max(AVATAR_URL_MAX_LENGTH)
				.refine(isAllowedAvatarUrl, {
					message: i18n._("Use an https:// image URL"),
				})
				.optional(),
		})
		.refine(
			(data) => !data.newPassword || data.newPassword !== data.currentPassword,
			{
				message: i18n._("New password must differ from current password"),
				path: ["newPassword"],
			},
		);

export type LoginInput = z.infer<ReturnType<typeof LoginSchema>>;
export type RegisterInput = z.infer<ReturnType<typeof RegisterSchema>>;
export type UpdateProfileInput = z.infer<
	ReturnType<typeof UpdateProfileSchema>
>;

export type UserDTO = Omit<
	typeof users.$inferSelect,
	| "passwordHash"
	| "totpSecretEncrypted"
	| "totpPendingSecretEncrypted"
	| "totpLastStep"
>;

/** 6-digit authenticator code or a `XXXXX-XXXXX` recovery code. */
export const TwoFactorCodeSchema = (i18n: I18n) =>
	z.object({
		code: z
			.string()
			.trim()
			.min(6, { message: i18n._("Enter the 6-digit code") })
			.max(20),
	});

/** Sensitive 2FA changes need the password and a current code. */
export const TwoFactorConfirmSchema = (i18n: I18n) =>
	TwoFactorCodeSchema(i18n).extend({
		password: z.string().min(1, { message: i18n._("Password is required") }),
	});

export const SessionIdSchema = z.object({ id: z.guid() });

export type LoginResult = { twoFactorRequired: boolean };

export interface TwoFactorStatus {
	enabled: boolean;
	enabledAt: Date | null;
	recoveryCodesLeft: number;
}

export interface TwoFactorEnrollment {
	secret: string;
	/** QR code of the URI as an SVG data URL (rendered on the server). */
	qrDataUrl: string;
}

export interface SessionDTO {
	id: string;
	createdAt: Date;
	lastSeenAt: Date;
	expiresAt: Date;
	ip: string | null;
	userAgent: string | null;
	current: boolean;
}
