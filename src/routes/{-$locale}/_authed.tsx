import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { teamContextQueryOptions } from "#/features/teams/teams.query.ts";
import { AppLayout } from "#/layouts/AppLayout.tsx";

/**
 * Pathless layout guarding every signed-in page. Anonymous visitors are
 * redirected to login with the original URL in `?redirect=` so they return
 * there afterwards. Server functions still enforce auth on their own.
 */
export const Route = createFileRoute("/{-$locale}/_authed")({
	beforeLoad: async ({ context, location }) => {
		if (!context.user) {
			throw redirect({
				to: "/{-$locale}/login",
				search: { redirect: location.href },
			});
		}
		// Team + permissions for the switcher and the role-aware UI.
		await context.queryClient.ensureQueryData(teamContextQueryOptions);
	},
	component: RouteComponent,
});

function RouteComponent() {
	return (
		<AppLayout>
			<Outlet />
		</AppLayout>
	);
}
