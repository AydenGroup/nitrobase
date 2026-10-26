import { useLingui } from "@lingui/react";
import { Alert, Anchor, Button, Group, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpCircle } from "lucide-react";
import { useCan } from "#/components/teams/useCan";
import { APP_NAME } from "#/config/shared.ts";
import { instanceUpdateQueryOptions } from "#/features/upgrade/upgrade.query.ts";
import { LocalizedLink } from "#/libs/i18n.ts";

/** Instance admins: a newer Nitrobase release exists (cached release check). */
export const InstanceUpdateBanner: React.FC = () => {
	const { i18n } = useLingui();
	const can = useCan();
	const admin = can("instance.manage");
	const { data } = useQuery({ ...instanceUpdateQueryOptions, enabled: admin });
	if (!admin || !data?.available || !data.latest) return null;
	return (
		<Alert
			color="brand"
			variant="light"
			icon={<ArrowUpCircle size={18} />}
			title={i18n._("{appName} {version} is available", {
				appName: APP_NAME,
				version: data.latest.version,
			})}
		>
			<Group gap="sm">
				<Text size="sm">
					{i18n._("You are running {version}.", { version: data.current })}
				</Text>
				{data.latest.url && (
					<Anchor
						href={data.latest.url}
						target="_blank"
						rel="noreferrer"
						size="sm"
					>
						{i18n._("Release notes")}
					</Anchor>
				)}
				<Button
					component={LocalizedLink}
					to="/settings/instance"
					size="xs"
					variant="light"
				>
					{i18n._("Upgrade")}
				</Button>
			</Group>
		</Alert>
	);
};
