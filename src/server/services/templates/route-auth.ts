import bcrypt from "bcryptjs";
import type { TemplateManifest } from "#/features/templates/schema.ts";
import { TemplateError } from "./naming";
import type { RouteInput } from "./traefik-dynamic";

export type PasswordHasher = (password: string) => string;

/** bcrypt for Traefik `basicAuth.users` (checked on every request: keep cost low). */
export function bcryptHasher(cost: number): PasswordHasher {
	return (password) => bcrypt.hashSync(password, cost);
}

/** Service -> variables holding its basic-auth credentials (template.toml). */
export function basicAuthByService(
	manifest: Pick<TemplateManifest, "domains">,
): Map<string, { username: string; password: string }> {
	const out = new Map<string, { username: string; password: string }>();
	for (const domain of manifest.domains) {
		if (domain.basic_auth) out.set(domain.service, domain.basic_auth);
	}
	return out;
}

/**
 * Attach basic auth to every route whose service is protected by the
 * template, from the app's current values. A protected service with missing
 * credentials is an error (never routed unprotected).
 */
export function withRouteAuth(
	routes: RouteInput[],
	manifest: Pick<TemplateManifest, "domains">,
	values: Record<string, string>,
	hash: PasswordHasher,
): RouteInput[] {
	const protectedServices = basicAuthByService(manifest);
	if (protectedServices.size === 0) return routes;
	const users = new Map<string, string[]>();
	for (const [service, vars] of protectedServices) {
		const username = values[vars.username];
		const password = values[vars.password];
		if (!username || !password) {
			throw new TemplateError("ROUTE_AUTH_MISSING", {
				service,
				username: vars.username,
				password: vars.password,
			});
		}
		if (!/^[A-Za-z0-9_.@-]{1,64}$/.test(username)) {
			throw new TemplateError("ROUTE_AUTH_USERNAME", { name: vars.username });
		}
		users.set(service, [`${username}:${hash(password)}`]);
	}
	return routes.map((route) => {
		const auth = users.get(route.service);
		return auth ? { ...route, basicAuth: auth } : route;
	});
}

/**
 * Add the template's path routes (`[[domains]].paths`) for every route of
 * the domain's service: same host and scheme, another service and port.
 */
export function withPathRoutes(
	routes: RouteInput[],
	manifest: Pick<TemplateManifest, "domains">,
): RouteInput[] {
	routes = withRootRedirects(routes, manifest);
	const byService = new Map(
		manifest.domains
			.filter((domain) => domain.paths.length > 0)
			.map((domain) => [domain.service, domain.paths]),
	);
	if (byService.size === 0) return routes;
	return routes.flatMap((route) => [
		route,
		...(route.pathPrefix ? [] : (byService.get(route.service) ?? [])).map(
			(path) => ({
				host: route.host,
				https: route.https,
				service: path.service,
				port: path.port,
				pathPrefix: path.prefix,
			}),
		),
	]);
}

/** The template's `root_redirect` on every route of that service and port. */
function withRootRedirects(
	routes: RouteInput[],
	manifest: Pick<TemplateManifest, "domains">,
): RouteInput[] {
	const redirects = manifest.domains.filter((domain) => domain.root_redirect);
	if (redirects.length === 0) return routes;
	return routes.map((route) => {
		const match = redirects.find(
			(domain) =>
				domain.service === route.service && domain.port === route.port,
		);
		return match && !route.pathPrefix
			? { ...route, rootRedirect: match.root_redirect }
			: route;
	});
}
