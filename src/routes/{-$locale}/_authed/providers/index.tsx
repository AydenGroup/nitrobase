import { createFileRoute, redirect } from "@tanstack/react-router";

/** Old URL: the Providers page is now the Marketplace. */
export const Route = createFileRoute("/{-$locale}/_authed/providers/")({
	beforeLoad: ({ params }) => {
		throw redirect({ to: "/{-$locale}/marketplace", params });
	},
});
