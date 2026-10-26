import { useLingui } from "@lingui/react";
import {
	Avatar,
	Badge,
	Box,
	Group,
	Kbd,
	Menu,
	Text,
	UnstyledButton,
} from "@mantine/core";
import { spotlight } from "@mantine/spotlight";
import {
	useQuery,
	useQueryClient,
	useSuspenseQuery,
} from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import {
	ArrowUpCircle,
	EarthIcon,
	EllipsisVertical,
	LogOutIcon,
	Search,
} from "lucide-react";
import { useCan } from "#/components/teams/useCan";
import { AccentPicker } from "#/components/ui/AccentPicker";
import { usePaletteShortcut } from "#/components/ui/CommandPalette";
import { ThemeSchemeControl } from "#/components/ui/ThemeSwitcher";
import { accountSection } from "#/config/navigation.ts";
import { roles } from "#/config/permissions.ts";
import { APP_VERSION } from "#/config/version.ts";
import { logoutFn } from "#/features/auth/auth.functions.ts";
import { userQueryOptions } from "#/features/auth/auth.query.ts";
import { twoFactorStatusQueryOptions } from "#/features/auth/security.query.ts";
import { teamDisplayName } from "#/features/teams/labels.ts";
import { teamContextQueryOptions } from "#/features/teams/teams.query.ts";
import { instanceUpdateQueryOptions } from "#/features/upgrade/upgrade.query.ts";
import { LocalizedLink, locales, useLocale } from "#/libs/i18n.ts";
import { useAccent } from "#/theme/accent-store.ts";
import { useAppMutation } from "../ui/useAppMutation";
import { UserAvatar } from "./UserAvatar";

/** Account pages that carry a status badge in the menu. */
const SECURITY_PATH = "/settings/security";

/**
 * Sidebar account button and menu: who is signed in (role and team), the
 * personal pages (navigation registry, `placement: "account"`), command
 * palette, theme and language, the running version (with an update hint
 * for instance admins) and logout. Reads the user primed by the root route.
 */
export const UserButton: React.FC<{ onNavigate?: () => void }> = ({
	onNavigate,
}) => {
	const { data: user } = useSuspenseQuery(userQueryOptions);
	const { data: teamContext } = useQuery(teamContextQueryOptions);
	const { data: twoFactor } = useQuery(twoFactorStatusQueryOptions);
	const can = useCan();
	const admin = can("instance.manage");
	const { data: update } = useQuery({
		...instanceUpdateQueryOptions,
		enabled: admin,
	});
	const { i18n } = useLingui();
	const shortcut = usePaletteShortcut();
	const { currentLocale, switchLocale } = useLocale();
	const [accent, setAccent] = useAccent();
	const router = useRouter();
	const queryClient = useQueryClient();
	// Server revokes the session and clears the cookie; then the cached user
	// becomes null so the login page lets us in. Everything else cached
	// belongs to the signed-out account: it is dropped once the signed-in
	// pages are gone, so they don't refetch without a session. A failed
	// request (offline, server down) leaves the session as is and says so.
	const logout = useAppMutation({
		mutationFn: () => logoutFn(),
		onSuccess: async () => {
			queryClient.setQueryData(userQueryOptions.queryKey, null);
			await router.navigate({ to: "/{-$locale}/login", replace: true });
			queryClient.clear();
		},
	});

	if (!user) return null;
	const name = `${user.firstName} ${user.lastName}`.trim();
	const team = teamContext?.team;
	const subtitle = team
		? `${i18n._(roles[team.role].label)} · ${teamDisplayName(i18n, team.name)}`
		: user.email;
	const language = locales.find((locale) => locale.code === currentLocale);
	const updateReady = admin && !!update?.available && !!update.latest;

	return (
		<Menu
			width={260}
			position="top-start"
			offset={8}
			shadow="md"
			radius="md"
			transitionProps={{ transition: "pop-bottom-left" }}
			withinPortal
		>
			<Menu.Target>
				<UnstyledButton
					className="user-button"
					p="xs"
					w="100%"
					aria-label={i18n._("Account menu")}
				>
					<Group gap="sm" wrap="nowrap">
						<UserAvatar user={user} radius="xl" size={36} />
						<Box style={{ flex: 1, minWidth: 0 }}>
							<Text size="sm" fw={500} truncate>
								{name}
							</Text>
							<Text c="dimmed" size="xs" truncate>
								{subtitle}
							</Text>
						</Box>
						<EllipsisVertical size={16} aria-hidden />
					</Group>
				</UnstyledButton>
			</Menu.Target>

			<Menu.Dropdown>
				<Group gap="sm" wrap="nowrap" p="xs">
					<UserAvatar user={user} radius="xl" size={36} />
					<Box style={{ minWidth: 0 }}>
						<Text size="sm" fw={600} truncate>
							{name}
						</Text>
						<Text size="xs" c="dimmed" truncate>
							{user.email}
						</Text>
					</Box>
				</Group>
				<Menu.Divider />

				{accountSection.items.map((item) => {
					const Icon = item.icon;
					return (
						<Menu.Item
							key={item.to}
							component={LocalizedLink}
							to={item.to}
							onClick={onNavigate}
							leftSection={<Icon size={16} />}
							rightSection={
								item.to === SECURITY_PATH && twoFactor ? (
									<Badge
										size="xs"
										variant="light"
										color={twoFactor.enabled ? "green" : "yellow"}
									>
										{twoFactor.enabled ? i18n._("2FA on") : i18n._("2FA off")}
									</Badge>
								) : undefined
							}
						>
							{i18n._(item.label)}
						</Menu.Item>
					);
				})}
				<Menu.Item
					leftSection={<Search size={16} />}
					rightSection={<Kbd size="xs">{shortcut}</Kbd>}
					onClick={() => spotlight.open()}
				>
					{i18n._("Command palette")}
				</Menu.Item>
				<Menu.Divider />

				<Group justify="space-between" wrap="nowrap" px="sm" py={6}>
					<Text size="sm">{i18n._("Theme")}</Text>
					<ThemeSchemeControl />
				</Group>
				<Group justify="space-between" wrap="nowrap" px="sm" py={6}>
					<Text size="sm" style={{ whiteSpace: "nowrap" }}>
						{i18n._("Accent color")}
					</Text>
					<AccentPicker value={accent} onChange={setAccent} />
				</Group>
				<Menu.Sub position="right-end">
					<Menu.Sub.Target>
						<Menu.Sub.Item
							leftSection={<EarthIcon size={16} />}
							rightSection={
								<Text size="xs" c="dimmed">
									{language?.nativeName}
								</Text>
							}
						>
							{i18n._("Language")}
						</Menu.Sub.Item>
					</Menu.Sub.Target>
					<Menu.Sub.Dropdown>
						<Menu.RadioGroup
							value={currentLocale}
							onChange={(code) => switchLocale(code)}
						>
							{locales.map((locale) => (
								<Menu.RadioItem
									key={locale.code}
									value={locale.code}
									lang={locale.code}
									rightSection={
										<Avatar
											size={16}
											src={`/flags/${locale.code}.svg`}
											alt=""
										/>
									}
									closeMenuOnClick
								>
									{locale.nativeName}
								</Menu.RadioItem>
							))}
						</Menu.RadioGroup>
					</Menu.Sub.Dropdown>
				</Menu.Sub>
				<Menu.Divider />

				{updateReady ? (
					<Menu.Item
						component={LocalizedLink}
						to="/settings/instance"
						onClick={onNavigate}
						leftSection={<ArrowUpCircle size={16} />}
						rightSection={
							<Badge size="xs" variant="light">
								{update.latest?.version}
							</Badge>
						}
					>
						{i18n._("Update available")}
					</Menu.Item>
				) : null}
				<Text size="xs" c="dimmed" px="sm" py={4}>
					{i18n._("Version {version}", { version: APP_VERSION })}
				</Text>
				<Menu.Divider />

				<Menu.Item
					color="red"
					leftSection={<LogOutIcon size={16} />}
					onClick={() => logout.mutate()}
					disabled={logout.isPending}
				>
					{logout.isPending ? i18n._("Logging out…") : i18n._("Log out")}
				</Menu.Item>
			</Menu.Dropdown>
		</Menu>
	);
};
