import { useLingui } from "@lingui/react";
import {
	Alert,
	Anchor,
	Button,
	Checkbox,
	Divider,
	PasswordInput,
	Stack,
	Text,
	TextInput,
	Title,
} from "@mantine/core";
import { schemaResolver, useForm } from "@mantine/form";

import { useQueryClient } from "@tanstack/react-query";
import { useRouter, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { safeRedirectPath } from "#/config/shared.ts";
import {
	loginFn,
	verifyLoginTwoFactorFn,
} from "#/features/auth/auth.functions.ts";
import { type LoginInput, LoginSchema } from "#/features/auth/schema.ts";
import { useAppMutation } from "../ui/useAppMutation";

/**
 * Sign-in form. When the account has 2FA enabled, the password step returns
 * `twoFactorRequired` and the form switches to a code prompt. Afterwards it
 * returns to the `?redirect=` target (same-origin paths only).
 */
export const LoginForm: React.FC = () => {
	const { i18n } = useLingui();
	const router = useRouter();
	const queryClient = useQueryClient();
	// `redirect` is set by the `_authed` guard when it bounced an anonymous
	// visitor here; `reason` explains why (e.g. the session was ended).
	const { redirect, reason } = useSearch({
		from: "/{-$locale}/login",
	});

	const form = useForm<LoginInput>({
		mode: "uncontrolled",
		initialValues: {
			email: "",
			password: "",
			rememberMe: false,
		},
		validate: schemaResolver(LoginSchema(i18n), { sync: true }),
	});

	const [twoFactor, setTwoFactor] = useState(false);
	const [code, setCode] = useState("");

	const finish = async () => {
		// A previous account's (or team's) data must not linger in the cache.
		queryClient.clear();
		await router.navigate({
			// Never follow external redirects (open redirect).
			href: safeRedirectPath(redirect),
			replace: true,
		});
	};

	const verify = useAppMutation({
		mutationFn: (value: string) =>
			verifyLoginTwoFactorFn({ data: { code: value } }),
		success: i18n._("You are logged in."),
		onSuccess: finish,
		onError: () => setCode(""),
	});

	const { mutate: login, isPending } = useAppMutation({
		mutationFn: (values: LoginInput) => loginFn({ data: values }),
		form,
		success: (result) =>
			result.twoFactorRequired ? null : i18n._("You are logged in."),
		onSuccess: async (result) => {
			if (result.twoFactorRequired) {
				setTwoFactor(true);
				return;
			}
			await finish();
		},
	});

	if (twoFactor) {
		return (
			<Stack gap="lg">
				<div>
					<Title order={1}>{i18n._("Two-factor authentication")}</Title>
					<Text c="dimmed">
						{i18n._(
							"Enter the 6-digit code from your authenticator app, or one of your recovery codes.",
						)}
					</Text>
				</div>
				<Divider />
				<form
					onSubmit={(event) => {
						event.preventDefault();
						if (code.trim()) verify.mutate(code.trim());
					}}
				>
					<Stack gap="md">
						<TextInput
							label={i18n._("Authentication code")}
							placeholder="123456"
							autoComplete="one-time-code"
							inputMode="text"
							autoFocus
							value={code}
							onChange={(event) => setCode(event.currentTarget.value)}
						/>
						<Button type="submit" fullWidth loading={verify.isPending}>
							{i18n._("Verify")}
						</Button>
						<Anchor
							component="button"
							type="button"
							size="sm"
							onClick={() => {
								setTwoFactor(false);
								setCode("");
							}}
						>
							{i18n._("Back to sign in")}
						</Anchor>
					</Stack>
				</form>
			</Stack>
		);
	}

	return (
		<Stack gap="lg">
			<div>
				<Title order={1}>{i18n._("Welcome back")}</Title>
				<Text c="dimmed">
					{i18n._("Sign in to manage your servers and apps.")}
				</Text>
			</div>
			{reason === "session_ended" && (
				<Alert color="yellow" variant="light">
					{i18n._(
						"You were signed out (the session was revoked or expired). Sign in again to continue.",
					)}
				</Alert>
			)}
			<form onSubmit={form.onSubmit((values) => login(values))}>
				<Stack gap="md">
					<TextInput
						label={i18n._("Email address")}
						placeholder={i18n._("you@company.com")}
						type="email"
						autoComplete="email"
						key={form.key("email")}
						{...form.getInputProps("email")}
					/>
					<PasswordInput
						label={i18n._("Password")}
						placeholder={i18n._("Your password")}
						autoComplete="current-password"
						key={form.key("password")}
						{...form.getInputProps("password")}
					/>
					<Checkbox
						label={i18n._("Remember me")}
						{...form.getInputProps("rememberMe", { type: "checkbox" })}
					/>
					<Button type="submit" fullWidth loading={isPending}>
						{i18n._("Sign in")}
					</Button>
				</Stack>
			</form>
			<Text size="sm" c="dimmed" ta="center">
				{i18n._("Joining a team? Use the invite link you received.")}
			</Text>
		</Stack>
	);
};
