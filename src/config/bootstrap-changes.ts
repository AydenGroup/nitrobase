import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import type { BootstrapPreview } from "#/features/servers/schema.ts";
import { branded } from "#/libs/brand.ts";

/**
 * What a bootstrap changes on a server, listed in the confirmation dialog
 * (client-safe registry). Each entry decides from the probe whether it
 * applies; `values` fills the message placeholders. Adding a bootstrap
 * step = one entry here.
 */
export interface BootstrapChange {
	id: string;
	label: MessageDescriptor;
	/** Highlighted (security-relevant) change. */
	important?: boolean;
	applies: (preview: BootstrapPreview) => boolean;
	values?: (preview: BootstrapPreview) => Record<string, string>;
}

export const bootstrapChanges: BootstrapChange[] = [
	{
		id: "managed-key",
		label: branded(
			msg({
				id: "Installs an SSH key managed by {appName} and deletes the stored password. From then on {appName} signs in with the key only.",
			}),
		),
		important: true,
		applies: (preview) => preview.managedKey,
	},
	{
		id: "packages",
		label: msg({
			id: "Installs missing base packages with apt ({packages}).",
		}),
		applies: () => true,
		values: (preview) => ({ packages: preview.packages.join(", ") }),
	},
	{
		id: "docker-install",
		label: msg({
			id: "Installs Docker Engine and the compose plugin from Docker's apt repository.",
		}),
		applies: (preview) => preview.dockerInstalled !== true,
	},
	{
		id: "docker-keep",
		label: msg({ id: "Uses the installed Docker {version}." }),
		applies: (preview) => preview.dockerInstalled === true,
		values: (preview) => ({ version: preview.dockerVersion ?? "" }),
	},
	{
		id: "networks",
		label: msg({ id: "Creates the Docker networks {networks} if missing." }),
		applies: () => true,
		values: (preview) => ({ networks: preview.networks.join(", ") }),
	},
	{
		id: "traefik-ports",
		label: msg({
			id: "Runs the Traefik reverse proxy ({container}) on ports 80 and 443.",
		}),
		important: true,
		applies: (preview) => !preview.tunnelOnly && !preview.traefikExists,
		values: (preview) => ({ container: preview.traefikContainer }),
	},
	{
		id: "traefik-tunnel",
		label: msg({
			id: "Runs the Traefik reverse proxy ({container}) without public ports (Cloudflare Tunnel only).",
		}),
		applies: (preview) => preview.tunnelOnly && !preview.traefikExists,
		values: (preview) => ({ container: preview.traefikContainer }),
	},
	{
		id: "traefik-recreate",
		label: msg({
			id: "Rewrites the configuration of the existing {container} and recreates it when the configuration changed (a few seconds without routing).",
		}),
		important: true,
		applies: (preview) => preview.traefikExists === true,
		values: (preview) => ({ container: preview.traefikContainer }),
	},
	{
		id: "managed-dirs",
		label: branded(
			msg({
				id: "Writes its configuration under {root} and marks the server as managed by this {appName} instance.",
			}),
		),
		applies: () => true,
		values: (preview) => ({ root: preview.root }),
	},
];
