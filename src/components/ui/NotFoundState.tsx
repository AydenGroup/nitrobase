import { useLingui } from "@lingui/react";
import { Button, Center, Stack, Text, ThemeIcon, Title } from "@mantine/core";
import { FileX, Home } from "lucide-react";
import { LocalizedLink, localeParams } from "#/libs/i18n.ts";

interface NotFoundStateProps {
	title?: string;
	description?: string;
}

/**
 * Full-page "not found" state used by route `notFoundComponent`s. Title and
 * description default to a generic localized message.
 */
export const NotFoundState: React.FC<NotFoundStateProps> = ({
	title,
	description,
}) => {
	const { i18n } = useLingui();
	const homeParams = localeParams(i18n.locale);

	return (
		<Center mih="80vh" p="md">
			<Stack align="center" gap="xl" maw={520}>
				<ThemeIcon size={80} radius={80} variant="light" color="gray">
					<FileX size={40} strokeWidth={1.5} />
				</ThemeIcon>
				<Stack align="center" gap="xs">
					<Title order={2} ta="center">
						{title ?? i18n._("Page not found")}
					</Title>
					<Text ta="center" c="dimmed" size="lg">
						{description ?? i18n._("This page does not exist or was moved.")}
					</Text>
				</Stack>
				<Button
					component={LocalizedLink}
					to="/"
					params={homeParams}
					leftSection={<Home size={18} />}
				>
					{i18n._("Back to dashboard")}
				</Button>
			</Stack>
		</Center>
	);
};
