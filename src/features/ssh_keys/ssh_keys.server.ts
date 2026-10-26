import { and, desc, eq, sql } from "drizzle-orm";
import { isForeignKeyViolation } from "#/db/errors.ts";
import { db } from "#/db/index.ts";
import { servers } from "#/db/schema/server.ts";
import { sshKeys } from "#/db/schema/ssh-keys.ts";
import type { Actor } from "#/features/auth/access.ts";
import {
	type ParsedKeyPair,
	parseKeyPair,
	SSHKeyParseError,
} from "#/server/services/ssh-key-parse.ts";
import { generateSSHKey } from "#/server/services/ssh-keygen.ts";
import { decrypt, encrypt } from "#/utils/crypto.ts";
import { AppError } from "#/utils/error.ts";
import type {
	GenerateSSHKeyInput,
	SSHKeyDTO,
	SSHKeyInput,
	SSHKeyUpdateInput,
} from "./schema";

/** Validate a key pair, mapping parse failures to user-facing AppErrors. */
function validateKeyPair(input: {
	privateKey: string;
	publicKey?: string;
	passphrase?: string;
}): ParsedKeyPair {
	try {
		return parseKeyPair(input);
	} catch (error) {
		if (error instanceof SSHKeyParseError) throw new AppError(error.code);
		throw error;
	}
}

/** Client-safe columns: never the encrypted private key or passphrase. */
const dtoColumns = {
	id: sshKeys.id,
	teamId: sshKeys.teamId,
	userId: sshKeys.userId,
	name: sshKeys.name,
	description: sshKeys.description,
	keyType: sshKeys.keyType,
	publicKey: sshKeys.publicKey,
	fingerprint: sshKeys.fingerprint,
	hasPassphrase: sql<boolean>`${sshKeys.passphraseEncrypted} is not null`,
	createdAt: sshKeys.createdAt,
	updatedAt: sshKeys.updatedAt,
} as const;

/** Keys owned by `userId`, newest first (no secrets). */
export async function listSSHKeys(actor: Actor): Promise<SSHKeyDTO[]> {
	return db
		.select(dtoColumns)
		.from(sshKeys)
		.where(eq(sshKeys.teamId, actor.teamId))
		.orderBy(desc(sshKeys.createdAt));
}

export interface SSHKeyCredentials {
	privateKey: string;
	passphrase?: string;
}

/** Decrypted key material of a team's key — only for internal server use. */
export async function getSSHKeyCredentials(
	actor: Pick<Actor, "teamId">,
	keyId: string,
): Promise<SSHKeyCredentials> {
	const rows = await db
		.select({
			privateKeyEncrypted: sshKeys.privateKeyEncrypted,
			passphraseEncrypted: sshKeys.passphraseEncrypted,
		})
		.from(sshKeys)
		.where(and(eq(sshKeys.id, keyId), eq(sshKeys.teamId, actor.teamId)))
		.limit(1);
	if (!rows[0]) throw new AppError("SSH_KEY_NOT_FOUND");
	return {
		privateKey: decrypt(rows[0].privateKeyEncrypted),
		passphrase: rows[0].passphraseEncrypted
			? decrypt(rows[0].passphraseEncrypted)
			: undefined,
	};
}

/** Decrypted private key (reveal action / internal use). */
export async function getSSHKeyPrivateKey(
	actor: Actor,
	keyId: string,
): Promise<string> {
	return (await getSSHKeyCredentials(actor, keyId)).privateKey;
}

/**
 * Stores a key for `userId`. The pair is parsed first: key type, public key
 * and fingerprint are derived from the private key (a supplied public key
 * must match it). Private key and passphrase are encrypted at rest.
 */
export async function createSSHKey(
	actor: Actor,
	data: SSHKeyInput,
): Promise<SSHKeyDTO> {
	const parsed = validateKeyPair(data);
	const [row] = await db
		.insert(sshKeys)
		.values({
			teamId: actor.teamId,
			userId: actor.userId,
			name: data.name,
			description: data.description,
			keyType: parsed.keyType,
			privateKeyEncrypted: encrypt(data.privateKey.trim()),
			passphraseEncrypted: data.passphrase ? encrypt(data.passphrase) : null,
			publicKey: parsed.publicKey,
			fingerprint: parsed.fingerprint,
		})
		.returning(dtoColumns);
	return row;
}

/**
 * Generates a key pair on the server (`ssh-keygen`, type from the registry)
 * and stores it encrypted. Returns only the DTO (public key included): the
 * private key stays on the server until an audited reveal.
 */
export async function generateAndStoreSSHKey(
	actor: Actor,
	data: GenerateSSHKeyInput,
): Promise<SSHKeyDTO> {
	const generated = await generateSSHKey(data.keyType);
	return createSSHKey(actor, {
		name: data.name,
		description: data.description,
		privateKey: generated.privateKey,
		publicKey: generated.publicKey,
	});
}

/**
 * Partial update of an owned key. Empty secret fields keep the stored
 * values; any key-material change (or `clearPassphrase`) re-validates and
 * re-encrypts the pair, so a passphrase is only ever stored for a key that
 * needs it. A rename/description edit touches no key material.
 */
export async function updateSSHKey(
	actor: Actor,
	keyId: string,
	data: SSHKeyUpdateInput,
): Promise<SSHKeyDTO> {
	const updates: Partial<typeof sshKeys.$inferInsert> = {
		updatedAt: new Date(),
	};
	if (data.name !== undefined) updates.name = data.name;
	if (data.description !== undefined) updates.description = data.description;

	const keyChanged = !!(
		data.privateKey ||
		data.publicKey ||
		data.passphrase ||
		data.clearPassphrase
	);
	if (keyChanged) {
		// Re-validate the effective pair so private/public keys can't drift.
		const current = await getSSHKeyCredentials(actor, keyId);
		const privateKey = data.privateKey?.trim() || current.privateKey;
		const passphrase = data.clearPassphrase
			? undefined
			: data.passphrase || (data.privateKey ? undefined : current.passphrase);
		const parsed = validateKeyPair({
			privateKey,
			publicKey: data.publicKey,
			passphrase,
		});
		updates.keyType = parsed.keyType;
		updates.privateKeyEncrypted = encrypt(privateKey);
		updates.passphraseEncrypted = passphrase ? encrypt(passphrase) : null;
		updates.publicKey = parsed.publicKey;
		updates.fingerprint = parsed.fingerprint;
	}

	const [row] = await db
		.update(sshKeys)
		.set(updates)
		.where(and(eq(sshKeys.id, keyId), eq(sshKeys.teamId, actor.teamId)))
		.returning(dtoColumns);
	if (!row) throw new AppError("SSH_KEY_NOT_FOUND");
	return row;
}

/**
 * Deletes an owned key; refused while any server uses it. The early check
 * gives the common case a clear answer; the foreign key (NO ACTION) closes
 * the race with a server being pointed at the key concurrently.
 */
export async function deleteSSHKey(actor: Actor, keyId: string): Promise<void> {
	const inUse = await db
		.select({ id: servers.id })
		.from(servers)
		.where(and(eq(servers.sshKeyId, keyId), eq(servers.teamId, actor.teamId)))
		.limit(1);
	if (inUse[0]) throw new AppError("SSH_KEY_IN_USE");

	const result = await db
		.delete(sshKeys)
		.where(and(eq(sshKeys.id, keyId), eq(sshKeys.teamId, actor.teamId)))
		.returning({ id: sshKeys.id })
		.catch((error: unknown) => {
			if (isForeignKeyViolation(error)) throw new AppError("SSH_KEY_IN_USE");
			throw error;
		});
	if (!result[0]) throw new AppError("SSH_KEY_NOT_FOUND");
}
