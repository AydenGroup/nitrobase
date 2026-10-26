import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";
import { LoginForm } from "#/components/auth/LoginForm.tsx";
import { userQueryOptions } from "#/features/auth/auth.query.ts";
import { AuthLayout } from "#/layouts/AuthLayout.tsx";

const loginSearchSchema = z.object({
	redirect: z.string().optional(),
	/** Why the user landed here (e.g. a revoked session). */
	reason: z.enum(["session_ended"]).optional(),
});

/**
 * Login page. Sends visitors to registration until the admin account exists,
 * and signed-in users to the dashboard. `?redirect=` is the page to return to.
 */
export const Route = createFileRoute("/{-$locale}/login")({
	beforeLoad: async ({ context }) => {
		if (!context.isSetupComplete) {
			throw redirect({
				to: "/{-$locale}/register",
			});
		}

		if (context.user) {
			// The cached user may hold a session the server has ended (a server
			// function sent us here): ask again before sending them back.
			const user = await context.queryClient.fetchQuery({
				...userQueryOptions,
				staleTime: 0,
			});
			if (user) {
				throw redirect({
					to: "/{-$locale}",
				});
			}
		}
	},
	validateSearch: loginSearchSchema,
	component: RouteComponent,
});

function RouteComponent() {
	return (
		<AuthLayout>
			<LoginForm />
		</AuthLayout>
	);
}
