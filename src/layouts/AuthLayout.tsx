import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import {
	Affix,
	Box,
	Center,
	Grid,
	Group,
	Stack,
	Text,
	Title,
} from "@mantine/core";
import type { PropsWithChildren } from "react";
import { BrandLogo } from "#/components/ui/BrandLogo.tsx";
import { LocaleButton } from "#/components/ui/LocaleButton.tsx";
import { ThemeSwitcher } from "#/components/ui/ThemeSwitcher.tsx";
import { APP_VERSION } from "#/config/version.ts";

/** One line of the sample deploy log in the hero. */
interface LogLine {
	at: string;
	done: boolean;
	text: MessageDescriptor;
	/** Highlighted part after the text (not translated: names, URLs). */
	detail?: string;
	/** Dimmed note after the text. */
	note?: MessageDescriptor;
}

/** A sample deploy, to show what the panel does (decoration only). */
const SAMPLE_DEPLOY: LogLine[] = [
	{
		at: "10:42:03",
		done: false,
		text: msg({ id: "Pulling images (12 services)" }),
	},
	{
		at: "10:42:41",
		done: false,
		text: msg({ id: "Starting containers on" }),
		detail: "fra-1",
	},
	{
		at: "10:42:58",
		done: true,
		text: msg({ id: "Health checks passed" }),
		note: msg({ id: "12/12 healthy" }),
	},
	{
		at: "10:43:02",
		done: true,
		text: msg({ id: "HTTPS ready" }),
		detail: "https://api.acme.dev",
	},
	{ at: "10:43:02", done: true, text: msg({ id: "Deployed in 59s" }) },
];

/**
 * Split-screen layout for login/registration: a brand panel (md and up,
 * always dark) with a sample deploy, and the form column with the
 * theme/locale switchers. Small screens get the logo above the form.
 */
export function AuthLayout({ children }: PropsWithChildren) {
	const { i18n } = useLingui();
	return (
		<Grid m={0} mih="100dvh" style={{ flexWrap: "nowrap" }}>
			<Grid.Col
				visibleFrom="md"
				span={7}
				p={0}
				pos="relative"
				className="auth-hero"
			>
				<Box className="auth-hero-grid" aria-hidden />
				<Stack
					pos="relative"
					h="100%"
					justify="space-between"
					px={64}
					py={48}
					c="white"
				>
					<BrandLogo size={34} />
					<Box>
						<Group className="auth-hero-chip" gap={8} wrap="nowrap">
							<span className="auth-hero-dot" />
							{i18n._("Self-hosted: your servers, your data")}
						</Group>
						<Title
							order={1}
							fz={{ md: 40, lg: 52 }}
							lh={1.06}
							fw={700}
							mt={22}
							mb={16}
							maw={560}
							style={{ letterSpacing: "-0.02em" }}
						>
							{i18n._("Launch backends on your own VPS.")}
						</Title>
						<Text fz="lg" c="gray.5" maw={520} lh={1.55}>
							{i18n._(
								"Supabase, Appwrite, PocketBase, databases and your Git apps, with HTTPS, backups and monitoring built in.",
							)}
						</Text>
						<Box className="auth-hero-log" mt={40} visibleFrom="lg" aria-hidden>
							<Group className="auth-hero-log-bar" gap={6}>
								<i />
								<i />
								<i />
								<Text component="span" ml={10} fz={11.5}>
									{i18n._("Deploy")} · supabase-prod
								</Text>
							</Group>
							<Stack gap={2} p="md">
								{SAMPLE_DEPLOY.map((line) => (
									<Text key={`${line.at}-${line.text.id}`} fz={12.5}>
										<span className="auth-hero-log-dim">{line.at}</span>
										{"  "}
										<span
											className={
												line.done ? "auth-hero-log-ok" : "auth-hero-log-step"
											}
										>
											{line.done ? "✓" : "→"}
										</span>{" "}
										{i18n._(line.text)}
										{line.detail && (
											<span className="auth-hero-log-detail">
												{" "}
												{line.detail}
											</span>
										)}
										{line.note && (
											<span className="auth-hero-log-dim">
												{"  "}
												{i18n._(line.note)}
											</span>
										)}
									</Text>
								))}
							</Stack>
						</Box>
					</Box>
					<Text size="sm" c="gray.6">
						{i18n._("Self-hosted infrastructure platform")} · v{APP_VERSION}
					</Text>
				</Stack>
			</Grid.Col>
			<Grid.Col span={{ base: 12, md: 5 }} p={0}>
				<Affix position={{ top: 20, right: 20 }}>
					<Group gap={2}>
						<ThemeSwitcher />
						<LocaleButton />
					</Group>
				</Affix>

				<Center
					px={{ base: 24, sm: 48 }}
					py={48}
					bg="var(--mantine-color-body)"
					mih="100dvh"
				>
					<Box w="100%" maw={400}>
						<Box hiddenFrom="md" mb={40} c="var(--sb-text-1)">
							<BrandLogo size={30} />
						</Box>
						{children}
					</Box>
				</Center>
			</Grid.Col>
		</Grid>
	);
}
