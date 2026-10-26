import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import type { ServerAuthMethod } from "./ssh-key-types.ts";

/**
 * How the panel signs in to a server, in the order the server form offers
 * them (first = default for new servers). Each id must exist in
 * `SERVER_AUTH_METHODS` (DB enum).
 */
export const serverAuthMethods: readonly {
	value: ServerAuthMethod;
	label: MessageDescriptor;
	/** Shown under a credential choice. */
	note?: MessageDescriptor;
}[] = [
	{ value: "private_key", label: msg({ id: "SSH private key" }) },
	{
		value: "password",
		label: msg({ id: "Password" }),
		note: msg({
			id: "Note: After successful connection, a managed SSH key will be installed on the server for future access.",
		}),
	},
];

export const DEFAULT_SERVER_AUTH_METHOD = serverAuthMethods[0].value;
