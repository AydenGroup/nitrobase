import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import {
	Alert,
	Button,
	Code,
	CopyButton,
	Group,
	Image,
	Modal,
	PasswordInput,
	SimpleGrid,
	Stack,
	Text,
	TextInput,
} from "@mantine/core";
import { useMounted } from "@mantine/hooks";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { useState } from "react";
import { SectionCard } from "#/components/ui/SectionCard";
import { StatusBadge } from "#/components/ui/StatusBadge";
import { useAppMutation } from "#/components/ui/useAppMutation";
import { downloadName } from "#/config/identifiers.ts";
import type { TwoFactorEnrollment } from "#/features/auth/schema.ts";
import {
	confirmTwoFactorEnrollmentFn,
	disableTwoFactorFn,
	regenerateRecoveryCodesFn,
	startTwoFactorEnrollmentFn,
} from "#/features/auth/security.functions.ts";
import { twoFactorStatusQueryOptions } from "#/features/auth/security.query.ts";
import { formatDate } from "#/libs/intl.ts";

/** Recovery codes, shown once, with copy and download. */
const RecoveryCodes: React.FC<{ codes: string[] }> = ({ codes }) => {
	const { i18n } = useLingui();
	const text = codes.join("\n");
	return (
		<Stack gap="xs">
			<Alert color="yellow" variant="light">
				{i18n._(
					"Save these recovery codes somewhere safe. Each works once if you lose your authenticator. They are not shown again.",
				)}
			</Alert>
			<SimpleGrid cols={2} spacing={4}>
				{codes.map((code) => (
					<Code key={code} ta="center">
						{code}
					</Code>
				))}
			</SimpleGrid>
			<Group>
				<CopyButton value={text}>
					{({ copied, copy }) => (
						<Button size="xs" variant="light" onClick={copy}>
							{copied ? i18n._("Copied") : i18n._("Copy")}
						</Button>
					)}
				</CopyButton>
				<Button
					size="xs"
					variant="default"
					component="a"
					href={`data:text/plain;charset=utf-8,${encodeURIComponent(text)}`}
					download={`${downloadName("recovery-codes")}.txt`}
				>
					{i18n._("Download")}
				</Button>
			</Group>
		</Stack>
	);
};

type Step = "closed" | "password" | "scan" | "codes" | "disable" | "regenerate";

export const TwoFactorCard: React.FC = () => {
	const { i18n } = useLingui();
	const mounted = useMounted();
	const queryClient = useQueryClient();
	const status = useQuery(twoFactorStatusQueryOptions);
	const [step, setStep] = useState<Step>("closed");
	const [password, setPassword] = useState("");
	const [code, setCode] = useState("");
	const [enrollment, setEnrollment] = useState<TwoFactorEnrollment | null>(
		null,
	);
	const [codes, setCodes] = useState<string[]>([]);
	const [othersRevoked, setOthersRevoked] = useState(0);
	const refresh = () =>
		queryClient.invalidateQueries({
			queryKey: twoFactorStatusQueryOptions.queryKey,
		});
	const close = () => {
		setStep("closed");
		setPassword("");
		setCode("");
		setEnrollment(null);
		setCodes([]);
		setOthersRevoked(0);
	};

	const start = useAppMutation({
		mutationFn: async () =>
			await startTwoFactorEnrollmentFn({ data: { password } }),
		field: "password",
		onSuccess: (data) => {
			setEnrollment(data);
			setPassword("");
			setStep("scan");
		},
	});
	const confirm = useAppMutation({
		mutationFn: async () =>
			await confirmTwoFactorEnrollmentFn({ data: { code } }),
		field: "code",
		success: i18n._("Two-factor authentication is on"),
		onSuccess: (data) => {
			setCodes(data.recoveryCodes);
			setOthersRevoked(data.otherSessionsRevoked);
			setCode("");
			setStep("codes");
			refresh();
		},
	});
	const disable = useAppMutation({
		mutationFn: async () =>
			await disableTwoFactorFn({ data: { password, code } }),
		field: "code",
		success: i18n._("Two-factor authentication is off"),
		onSuccess: () => {
			close();
			refresh();
		},
	});
	const regenerate = useAppMutation({
		mutationFn: async () =>
			await regenerateRecoveryCodesFn({ data: { password, code } }),
		field: "code",
		success: i18n._("New recovery codes created"),
		onSuccess: (data) => {
			setCodes(data.recoveryCodes);
			setPassword("");
			setCode("");
			setStep("codes");
			refresh();
		},
	});

	const enabled = status.data?.enabled ?? false;
	const passwordAndCode = (
		action: {
			mutate: () => void;
			isPending: boolean;
			fieldError: () => string | undefined;
			clearFieldError: () => void;
		},
		label: string,
		color?: string,
	) => (
		<Stack>
			<PasswordInput
				label={i18n._("Password")}
				value={password}
				onChange={(event) => setPassword(event.currentTarget.value)}
				autoComplete="current-password"
			/>
			<TextInput
				label={i18n._("Authentication or recovery code")}
				value={code}
				onChange={(event) => {
					action.clearFieldError();
					setCode(event.currentTarget.value);
				}}
				error={action.fieldError()}
				autoComplete="one-time-code"
			/>
			<Group justify="flex-end">
				<Button variant="default" onClick={close}>
					{i18n._("Cancel")}
				</Button>
				<Button
					color={color}
					loading={action.isPending}
					disabled={!password || !code.trim()}
					onClick={() => action.mutate()}
				>
					{label}
				</Button>
			</Group>
		</Stack>
	);

	return (
		<SectionCard
			title={i18n._("Two-factor authentication")}
			description={i18n._(
				"Ask for a code from an authenticator app (TOTP) at every sign-in.",
			)}
			actions={
				<StatusBadge
					meta={{
						label: enabled ? msg({ id: "On" }) : msg({ id: "Off" }),
						tone: enabled ? "success" : "neutral",
					}}
				/>
			}
		>
			{enabled ? (
				<Stack gap="sm">
					<Text size="sm">
						{i18n._("Enabled {date} · {count} recovery codes left", {
							// After hydration: SSR runs in the server's time zone.
							date:
								mounted && status.data?.enabledAt
									? formatDate(i18n.locale, status.data.enabledAt, {
											dateStyle: "medium",
										})
									: "",
							count: status.data?.recoveryCodesLeft ?? 0,
						})}
					</Text>
					<Group>
						<Button variant="default" onClick={() => setStep("regenerate")}>
							{i18n._("New recovery codes")}
						</Button>
						<Button
							color="red"
							variant="light"
							onClick={() => setStep("disable")}
						>
							{i18n._("Turn off")}
						</Button>
					</Group>
				</Stack>
			) : (
				<Button
					leftSection={<ShieldCheck size={16} />}
					onClick={() => setStep("password")}
				>
					{i18n._("Set up two-factor authentication")}
				</Button>
			)}
			<Modal
				opened={step !== "closed"}
				onClose={close}
				title={i18n._("Two-factor authentication")}
				centered
				closeOnClickOutside={step !== "codes"}
			>
				{step === "password" && (
					<Stack>
						<PasswordInput
							label={i18n._("Confirm your password")}
							value={password}
							onChange={(event) => {
								start.clearFieldError();
								setPassword(event.currentTarget.value);
							}}
							error={start.fieldError()}
							autoComplete="current-password"
						/>
						<Group justify="flex-end">
							<Button
								loading={start.isPending}
								disabled={!password}
								onClick={() => start.mutate()}
							>
								{i18n._("Continue")}
							</Button>
						</Group>
					</Stack>
				)}
				{step === "scan" && enrollment && (
					<Stack>
						<Text size="sm">
							{i18n._(
								"Scan the QR code with your authenticator app (or type the key), then enter the code it shows.",
							)}
						</Text>
						<Image
							src={enrollment.qrDataUrl}
							alt={i18n._("QR code")}
							w={200}
							h={200}
							mx="auto"
							bg="white"
							p={4}
						/>
						<Code block ta="center">
							{enrollment.secret.match(/.{1,4}/g)?.join(" ")}
						</Code>
						<TextInput
							label={i18n._("Code from the app")}
							value={code}
							onChange={(event) => {
								confirm.clearFieldError();
								setCode(event.currentTarget.value);
							}}
							error={confirm.fieldError()}
							autoComplete="one-time-code"
							inputMode="numeric"
						/>
						<Group justify="flex-end">
							<Button
								loading={confirm.isPending}
								disabled={code.trim().length < 6}
								onClick={() => confirm.mutate()}
							>
								{i18n._("Turn on")}
							</Button>
						</Group>
					</Stack>
				)}
				{step === "codes" && (
					<Stack>
						<RecoveryCodes codes={codes} />
						{othersRevoked > 0 && (
							<Text size="sm" c="dimmed">
								{i18n._("{count} other sessions were signed out.", {
									count: othersRevoked,
								})}
							</Text>
						)}
						<Group justify="flex-end">
							<Button onClick={close}>{i18n._("I saved them")}</Button>
						</Group>
					</Stack>
				)}
				{step === "disable" &&
					passwordAndCode(disable, i18n._("Turn off"), "red")}
				{step === "regenerate" &&
					passwordAndCode(regenerate, i18n._("Create new codes"))}
			</Modal>
		</SectionCard>
	);
};
