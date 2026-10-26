import { stringify as stringifyYaml } from "yaml";
import { assertHostname, assertSlug, TemplateError } from "./naming";

export interface RouteInput {
	host: string;
	service: string;
	port: number;
	https: boolean;
	/** Optional path prefix, e.g. "/api". */
	pathPrefix?: string;
	/** HTTP basic auth: htpasswd lines (`user:<bcrypt hash>`). */
	basicAuth?: string[];
	/** Redirect `/` to this path (temporary redirect). */
	rootRedirect?: string;
	/**
	 * Served through a Cloudflare Tunnel: only on the unpublished `tunnel`
	 * entrypoint (plain HTTP, Cloudflare terminates TLS), never on `web`.
	 */
	tunnel?: boolean;
}

/** Entrypoint name of tunnel routes (Traefik static config). */
const TUNNEL_ENTRYPOINT = "tunnel";

export interface TraefikDynamicInput {
	/** Unique app identifier; router/service names are derived from it. */
	appKey: string;
	routes: RouteInput[];
	containerNames: Record<string, string>;
	certResolver: string;
}

const PATH_PREFIX = /^\/[A-Za-z0-9._~\-/]*$/;
/** `user:bcrypt-hash` (Traefik accepts $2a$/$2b$/$2y$ bcrypt). */
const HTPASSWD_LINE =
	/^[A-Za-z0-9_.@-]{1,64}:\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

/**
 * Routes of hosts served through a Cloudflare Tunnel: Cloudflare terminates
 * TLS and cloudflared forwards plain HTTP to Traefik's unpublished `tunnel`
 * entrypoint. No certificate resolver, no HTTPS redirect (it would loop
 * behind the tunnel), and never on `web`: the server's public :80 must not
 * serve them (that would bypass Cloudflare Access/WAF).
 */
export function servedThroughTunnel(
	routes: RouteInput[],
	tunnelHosts: ReadonlySet<string>,
): RouteInput[] {
	return routes.map((route) =>
		tunnelHosts.has(route.host)
			? { ...route, https: false, tunnel: true }
			: route,
	);
}

/** Stable short key for an app's Traefik names and file. */
export function traefikAppKey(appId: string): string {
	return appId.replace(/-/g, "").slice(0, 12).toLowerCase();
}

/** Per-app file name inside the Traefik dynamic directory. */
export function traefikAppFileName(appKey: string): string {
	return `app-${assertSlug(appKey)}.yml`;
}

/**
 * Traefik file-provider config for one app. Every router/service/middleware
 * name is prefixed with `app-<appKey>-` so apps never collide. HTTPS routes
 * get an HTTP router that redirects, plus a websecure router with the ACME
 * resolver. (Phase D: `domains.host` gets a unique index so two apps can't
 * claim the same host.)
 */
export function generateTraefikDynamic(input: TraefikDynamicInput): string {
	const key = `app-${assertSlug(input.appKey)}`;
	const routers: Record<string, unknown> = {};
	const services: Record<string, unknown> = {};
	const middlewares: Record<string, unknown> = {};
	const seen = new Set<string>();

	input.routes.forEach((route, index) => {
		const host = assertHostname(route.host);
		const container = input.containerNames[route.service];
		if (!container) {
			throw new TemplateError("ROUTE_SERVICE_UNKNOWN", {
				service: route.service,
			});
		}
		if (!Number.isInteger(route.port) || route.port < 1 || route.port > 65535) {
			throw new TemplateError("ROUTE_PORT_INVALID", {
				port: String(route.port),
				host,
			});
		}
		if (route.pathPrefix !== undefined && !PATH_PREFIX.test(route.pathPrefix)) {
			throw new TemplateError("ROUTE_PATH_INVALID", {
				path: route.pathPrefix,
			});
		}
		const identity = `${host}${route.pathPrefix ?? ""}`;
		if (seen.has(identity))
			throw new TemplateError("ROUTE_DUPLICATE", { route: identity });
		seen.add(identity);

		const name = `${key}-${index}`;
		const routeMiddlewares: string[] = [];
		if (route.basicAuth) {
			if (
				route.basicAuth.length === 0 ||
				!route.basicAuth.every((line) => HTPASSWD_LINE.test(line))
			) {
				throw new TemplateError("ROUTE_AUTH_INVALID", { host });
			}
			const auth = `${name}-auth`;
			middlewares[auth] = {
				basicAuth: { users: route.basicAuth, removeHeader: true },
			};
			routeMiddlewares.push(auth);
		}
		if (route.rootRedirect !== undefined) {
			if (!PATH_PREFIX.test(route.rootRedirect) || route.rootRedirect === "/") {
				throw new TemplateError("ROUTE_REDIRECT_INVALID", {
					path: route.rootRedirect,
				});
			}
		}
		const withMiddlewares = (router: Record<string, unknown>) =>
			routeMiddlewares.length
				? { ...router, middlewares: routeMiddlewares }
				: router;
		const rule =
			route.pathPrefix && route.pathPrefix !== "/"
				? `Host(\`${host}\`) && PathPrefix(\`${route.pathPrefix}\`)`
				: `Host(\`${host}\`)`;

		services[name] = {
			loadBalancer: { servers: [{ url: `http://${container}:${route.port}` }] },
		};
		// Only a browser opening `/` is redirected (GET): APIs on the same
		// host may POST to `/` (e.g. S3 STS).
		if (route.rootRedirect) {
			const redirect = `${name}-root`;
			middlewares[redirect] = {
				redirectRegex: {
					regex: "^(https?://[^/]+)/?$",
					replacement: `\${1}${route.rootRedirect}`,
					permanent: false,
				},
			};
			routers[redirect] = {
				rule: `Host(\`${host}\`) && Path(\`/\`) && Method(\`GET\`)`,
				entryPoints: [
					route.tunnel ? TUNNEL_ENTRYPOINT : route.https ? "websecure" : "web",
				],
				middlewares: [...routeMiddlewares, redirect],
				service: name,
				...(route.https ? { tls: { certResolver: input.certResolver } } : {}),
			};
		}
		if (route.https) {
			const redirect = `${key}-https-redirect`;
			middlewares[redirect] = {
				redirectScheme: { scheme: "https", permanent: true },
			};
			routers[`${name}-http`] = {
				rule,
				entryPoints: ["web"],
				middlewares: [redirect],
				service: name,
			};
			routers[name] = withMiddlewares({
				rule,
				entryPoints: ["websecure"],
				service: name,
				tls: { certResolver: input.certResolver },
			});
		} else {
			routers[name] = withMiddlewares({
				rule,
				entryPoints: [route.tunnel ? TUNNEL_ENTRYPOINT : "web"],
				service: name,
			});
		}
	});

	const http: Record<string, unknown> = { routers, services };
	if (Object.keys(middlewares).length) http.middlewares = middlewares;
	return stringifyYaml({ http }, { lineWidth: 0 });
}
