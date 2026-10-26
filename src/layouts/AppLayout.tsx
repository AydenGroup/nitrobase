import { useLingui } from "@lingui/react";
import {
	AppShell,
	Box,
	Burger,
	Container,
	Group,
	ScrollArea,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { useQuery } from "@tanstack/react-query";
import { Users } from "lucide-react";
import type { PropsWithChildren } from "react";
import { UserButton } from "#/components/auth/UserButton.tsx";
import { InstancePausedBanner } from "#/components/settings/InstancePausedBanner.tsx";
import { TeamSwitcher } from "#/components/teams/TeamSwitcher.tsx";
import { BrandLogo } from "#/components/ui/BrandLogo.tsx";
import { BreadcrumbNav } from "#/components/ui/BreadcrumbNav.tsx";
import {
	CommandPalette,
	CommandPaletteButton,
} from "#/components/ui/CommandPalette.tsx";
import { EmptyState } from "#/components/ui/EmptyState.tsx";
import { NavigationMenu } from "#/components/ui/NavigationMenu.tsx";
import { teamContextQueryOptions } from "#/features/teams/teams.query.ts";
import { appFrame } from "#/theme/tokens.ts";

/**
 * Signed-in app shell: header (breadcrumbs, command palette), sidebar
 * navigation and the account menu (theme, language, version, logout). On mobile the sidebar is
 * a burger-toggled drawer that closes after navigating.
 */
export const AppLayout: React.FC<PropsWithChildren> = ({ children }) => {
	const { i18n } = useLingui();
	const [opened, { toggle, close }] = useDisclosure();
	const { data: teamContext } = useQuery(teamContextQueryOptions);
	return (
		// "alt" layout: the navbar spans the full height. The header only exists on
		// mobile; from `sm` up the content panel carries its own top bar.
		<AppShell
			layout="alt"
			header={{ height: { base: appFrame.mobileHeaderHeight, sm: 0 } }}
			navbar={{
				width: appFrame.navbarWidth,
				breakpoint: "sm",
				collapsed: { mobile: !opened },
			}}
			padding={0}
		>
			<AppShell.Header hiddenFrom="sm">
				<Group h="100%" px="md">
					<Burger
						opened={opened}
						onClick={toggle}
						hiddenFrom="sm"
						size="sm"
						aria-label={
							opened ? i18n._("Close navigation") : i18n._("Open navigation")
						}
					/>
					<Box visibleFrom="xs" style={{ minWidth: 0, overflow: "hidden" }}>
						<BreadcrumbNav />
					</Box>
					<Group gap={4} ml="auto">
						<CommandPaletteButton />
					</Group>
				</Group>
			</AppShell.Header>
			<AppShell.Navbar p="sm">
				<AppShell.Section>
					<Box ml="xs" mb="sm" c="var(--sb-text-1)">
						<BrandLogo />
					</Box>
					<TeamSwitcher onNavigate={close} />
				</AppShell.Section>
				{/* Scrollbar always visible on overflow so the last items are discoverable. */}
				<AppShell.Section
					grow
					mt="md"
					mb="xs"
					component={ScrollArea}
					type="auto"
					offsetScrollbars
				>
					<NavigationMenu onNavigate={close} />
				</AppShell.Section>
				<AppShell.Section className="navbar-account">
					<UserButton onNavigate={close} />
				</AppShell.Section>
			</AppShell.Navbar>
			<CommandPalette />
			<AppShell.Main>
				<div className="app-panel">
					<Group
						className="app-panel-bar"
						visibleFrom="sm"
						wrap="nowrap"
						justify="space-between"
					>
						<Box className="app-panel-crumbs">
							<BreadcrumbNav />
						</Box>
						<CommandPaletteButton />
					</Group>
					{/* Padding on a wrapper: Container's own `p` is inline and would win. */}
					<div className="app-panel-body">
						<Container size={1200} p={0}>
							<InstancePausedBanner />
							{teamContext === null ? (
								<EmptyState
									icon={Users}
									title={i18n._("No team yet")}
									description={i18n._(
										"You are not a member of any team. Ask a team owner for an invite link.",
									)}
								/>
							) : (
								children
							)}
						</Container>
					</div>
				</div>
			</AppShell.Main>
		</AppShell>
	);
};
