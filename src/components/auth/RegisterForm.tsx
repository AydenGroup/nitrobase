import { useLingui } from "@lingui/react";
import {
	Anchor,
	Button,
	Divider,
	Group,
	PasswordInput,
	Stack,
	Text,
	TextInput,
	Title,
} from "@mantine/core";
import { schemaResolver, useForm } from "@mantine/form";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { PASSWORD_MIN_LENGTH } from "#/config/shared.ts";
import { registerFn } from "#/features/auth/auth.functions.ts";
import type { RegisterInput } from "#/features/auth/schema.ts";
import { RegisterSchema } from "#/features/auth/schema.ts";
import { LocalizedLink } from "#/libs/i18n.ts";
import { useAppMutation } from "../ui/useAppMutation";

/**
 * Sign-up: the first-run admin account, or (with `invite`) an account that
 * joins the inviting team. On success the server has already signed the
 * user in; the form then lands on the dashboard.
 */
export const RegisterForm: React.FC<{
	invite?: { token: string; email: string | null; teamName: string };
	/** First account: the installer's setup token is required. */
	setupTokenRequired?: boolean;
}> = ({ invite, setupTokenRequired = false }) => {
	const { i18n } = useLingui();
	const router = useRouter();
	const queryClient = useQueryClient();

	const form = useForm<RegisterInput>({
		mode: "uncontrolled",
		initialValues: {
			firstName: "",
			lastName: "",
			email: invite?.email ?? "",
			password: "",
			confirmPassword: "",
			setupToken: "",
		},
		validate: schemaResolver(RegisterSchema(i18n), { sync: true }),
	});

	const { mutate: register, isPending } = useAppMutation({
		mutationFn: (values: RegisterInput) =>
			registerFn({ data: { ...values, invite: invite?.token } }),
		form,
		success: i18n._("Your account has been successfully created."),
		onSuccess: async () => {
			// The root route caches both with `staleTime: "static"`; drop them
			// so the next navigation sees the new user and closed registration.
			// Nothing cached before sign-up belongs to the new account/team.
			queryClient.clear();
			await router.navigate({ to: "/{-$locale}", replace: true });
		},
	});

	return (
		<Stack gap="lg">
			<div>
				<Title order={1}>{i18n._("Create your account")}</Title>
				<Text c="dimmed">
					{invite
						? i18n._("Create an account to join the team “{team}”.", {
								team: invite.teamName,
							})
						: i18n._("Start managing deployments in minutes.")}
				</Text>
			</div>
			<Divider />
			<form onSubmit={form.onSubmit((values) => register(values))}>
				<Stack gap="md">
					<Group grow align="flex-start" wrap="wrap">
						<TextInput
							label={i18n._("First name")}
							placeholder={i18n._("Jane")}
							autoComplete="given-name"
							key={form.key("firstName")}
							{...form.getInputProps("firstName")}
						/>
						<TextInput
							label={i18n._("Last name")}
							placeholder={i18n._("Doe")}
							autoComplete="family-name"
							key={form.key("lastName")}
							{...form.getInputProps("lastName")}
						/>
					</Group>
					<TextInput
						label={i18n._("Email address")}
						placeholder={i18n._("you@company.com")}
						type="email"
						autoComplete="email"
						readOnly={!!invite?.email}
						key={form.key("email")}
						{...form.getInputProps("email")}
					/>
					<PasswordInput
						label={i18n._("Password")}
						description={i18n._("Use at least {min} characters", {
							min: PASSWORD_MIN_LENGTH,
						})}
						placeholder={i18n._("Create a password")}
						autoComplete="new-password"
						key={form.key("password")}
						{...form.getInputProps("password")}
					/>
					<PasswordInput
						label={i18n._("Confirm password")}
						placeholder={i18n._("Repeat your password")}
						autoComplete="new-password"
						key={form.key("confirmPassword")}
						{...form.getInputProps("confirmPassword")}
					/>
					{setupTokenRequired && !invite && (
						<TextInput
							label={i18n._("Setup token")}
							description={i18n._(
								"Printed by the installer (SETUP_TOKEN in the install's .env). Needed until the first account exists.",
							)}
							autoComplete="off"
							spellCheck={false}
							key={form.key("setupToken")}
							{...form.getInputProps("setupToken")}
						/>
					)}
					<Button type="submit" fullWidth loading={isPending}>
						{i18n._("Create account")}
					</Button>
				</Stack>
			</form>
			{!invite && (
				<Text ta="center" size="sm" c="dimmed">
					{i18n._("Already have an account?")}{" "}
					<Anchor component={LocalizedLink} to="/{-$locale}/login">
						{i18n._("Sign in")}
					</Anchor>
				</Text>
			)}
		</Stack>
	);
};
