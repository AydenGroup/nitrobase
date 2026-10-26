import { createServerFn } from "@tanstack/react-start";
import { requirePermission } from "#/features/auth/permissionMiddleware";
import { i18nMiddleware } from "#/libs/i18n.ts";
import { audit } from "#/server/services/audit.ts";
import { GenerateSSHKeySchema } from "./schema";
import { generateAndStoreSSHKey } from "./ssh_keys.server";

/**
 * Generates a key pair on the server and stores it in the key library.
 * Returns the stored key without secrets (its public key is included, to
 * add to `authorized_keys`); the private key is only readable through the
 * audited `revealSSHKeyFn`.
 */
export const generateSSHKeyFn = createServerFn({ method: "POST" })
	.validator((data) => data)
	.middleware([i18nMiddleware, requirePermission("ssh_key.manage")])
	.handler(async ({ data, context }) => {
		const parsed = GenerateSSHKeySchema(context.i18n).parse(data);
		const key = await generateAndStoreSSHKey(context.actor, parsed);
		audit({
			actor: context.actor,
			action: "ssh_key.create",
			targetType: "ssh_key",
			targetId: key.id,
			meta: { name: parsed.name, generated: true, keyType: parsed.keyType },
		});
		return key;
	});
