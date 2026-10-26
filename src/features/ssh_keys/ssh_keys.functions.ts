import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requirePermission } from "#/features/auth/permissionMiddleware";
import { i18nMiddleware } from "#/libs/i18n.ts";
import { audit } from "#/server/services/audit.ts";
import { AddSSHKeySchema, UpdateSSHKeySchema } from "./schema";
import {
	createSSHKey,
	deleteSSHKey,
	getSSHKeyPrivateKey,
	listSSHKeys,
	updateSSHKey,
} from "./ssh_keys.server";

// SSH key RPCs. Every function is gated by a permission and scopes all
// queries to `context.actor`; only `revealSSHKeyFn` returns secrets.

export const listSSHKeysFn = createServerFn({ method: "GET" })
	.middleware([requirePermission("ssh_key.view")])
	.handler(async ({ context }) => {
		return listSSHKeys(context.actor);
	});

/** Decrypted private key for the edit form. POST + audited, never cached. */
export const revealSSHKeyFn = createServerFn({ method: "POST" })
	.middleware([requirePermission("ssh_key.reveal")])
	.validator((keyId: string) => z.guid().parse(keyId))
	.handler(async ({ context, data }) => {
		const privateKey = await getSSHKeyPrivateKey(context.actor, data);
		audit({
			actor: context.actor,
			action: "ssh_key.reveal",
			targetType: "ssh_key",
			targetId: data,
		});
		return privateKey;
	});

/** Validates with the localized schema (i18nMiddleware runs first). */
export const addSSHKeyFn = createServerFn({ method: "POST" })
	.validator((data) => data)
	.middleware([i18nMiddleware, requirePermission("ssh_key.manage")])
	.handler(async ({ data, context }) => {
		const parsed = AddSSHKeySchema(context.i18n).parse(data);
		const key = await createSSHKey(context.actor, parsed);
		audit({
			actor: context.actor,
			action: "ssh_key.create",
			targetType: "ssh_key",
			targetId: key.id,
			meta: { name: parsed.name },
		});
		return key;
	});

export const updateSSHKeyFn = createServerFn({ method: "POST" })
	.validator((data) => data)
	.middleware([i18nMiddleware, requirePermission("ssh_key.manage")])
	.handler(async ({ data, context }) => {
		const parsed = UpdateSSHKeySchema(context.i18n).parse(data);
		const { id, ...updateData } = parsed;
		const key = await updateSSHKey(context.actor, id, updateData);
		audit({
			actor: context.actor,
			action: "ssh_key.update",
			targetType: "ssh_key",
			targetId: id,
			// Which parts changed, never their values.
			meta: {
				fields: Object.entries(updateData)
					.filter(([, value]) => value !== undefined)
					.map(([field]) => field),
			},
		});
		return key;
	});

export const deleteSSHKeyFn = createServerFn({ method: "POST" })
	.validator((keyId: string) => z.guid().parse(keyId))
	.middleware([requirePermission("ssh_key.manage")])
	.handler(async ({ context, data }) => {
		await deleteSSHKey(context.actor, data);
		audit({
			actor: context.actor,
			action: "ssh_key.delete",
			targetType: "ssh_key",
			targetId: data,
		});
		return { success: true };
	});
