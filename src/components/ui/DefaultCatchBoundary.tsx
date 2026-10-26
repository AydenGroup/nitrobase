import { useLingui } from "@lingui/react";
import {
	Alert,
	Box,
	Button,
	Code,
	Container,
	Group,
	Stack,
	Text,
	ThemeIcon,
	Title,
} from "@mantine/core";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { rootRouteId, useMatch, useRouter } from "@tanstack/react-router";
import { AlertTriangle, ArrowLeft, Home, RefreshCw } from "lucide-react";
import { LocalizedLink, localeParams } from "#/libs/i18n.ts";

/**
 * Route error boundary (root and locale routes). Shows the raw error message
 * only in development. "Try again" re-runs loaders via `router.invalidate()`.
 */
export const DefaultCatchBoundary: React.FC<ErrorComponentProps> = ({
	error,
}) => {
	const { i18n } = useLingui();
	const homeParams = localeParams(i18n.locale);
	const router = useRouter();
	const isRoot = useMatch({
		strict: false,
		select: (state) => state.id === rootRouteId,
	});

	const errorMessage =
		error instanceof Error
			? error.message
			: i18n._("An unexpected error occurred");

	return (
		<Box
			style={{
				flex: 1,
				minWidth: 0,
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				minHeight: "100dvh",
			}}
		>
			<Container size="sm" py="xl">
				<Stack align="center" gap="xl">
					<ThemeIcon size={72} radius="xl" color="red" variant="light">
						<AlertTriangle size={40} stroke="1.5" />
					</ThemeIcon>

					<Stack align="center" gap="xs">
						<Title order={2} ta="center" fw={700}>
							{i18n._("Something went wrong")}
						</Title>
						<Text c="dimmed" ta="center" maw={420}>
							{i18n._(
								"An unexpected error occurred. You can try again or return to the home page.",
							)}
						</Text>
					</Stack>

					{import.meta.env.DEV && (
						<Alert
							color="red"
							variant="light"
							radius="md"
							w="100%"
							title={i18n._("Error details")}
							icon={<AlertTriangle size={16} />}
						>
							<Code
								block
								style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}
							>
								{errorMessage}
							</Code>
						</Alert>
					)}

					<Group justify="center" gap="sm">
						<Button
							variant="default"
							leftSection={<RefreshCw size={18} />}
							onClick={() => router.invalidate()}
						>
							{i18n._("Try Again")}
						</Button>
						{/* At the root there is nowhere to go back to, so link home. */}
						{isRoot ? (
							<Button
								component={LocalizedLink}
								to="/"
								params={homeParams}
								leftSection={<Home size={18} />}
							>
								{i18n._("Home")}
							</Button>
						) : (
							<Button
								leftSection={<ArrowLeft size={18} />}
								onClick={() => router.history.back()}
							>
								{i18n._("Go Back")}
							</Button>
						)}
					</Group>
				</Stack>
			</Container>
		</Box>
	);
};
