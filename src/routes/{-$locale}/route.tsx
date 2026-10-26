import { createFileRoute, notFound, Outlet } from "@tanstack/react-router";
import { DefaultCatchBoundary } from "#/components/ui/DefaultCatchBoundary.tsx";
import { NotFoundState } from "#/components/ui/NotFoundState.tsx";
import { isValidLocale } from "#/libs/i18n";

/**
 * Optional locale segment (`/vi/...`). No prefix means the default locale
 * (the server entry strips `/en`); an unsupported locale renders 404.
 */
export const Route = createFileRoute("/{-$locale}")({
	beforeLoad: ({ params }) => {
		const locale = params.locale;
		if (locale && !isValidLocale(locale)) {
			throw notFound();
		}
	},
	errorComponent: DefaultCatchBoundary,
	notFoundComponent: () => <NotFoundState />,
	component: RouteComponent,
});

function RouteComponent() {
	return <Outlet />;
}
