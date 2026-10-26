import {
	createDecipheriv,
	createHash,
	type Hash,
	pbkdf2Sync,
} from "node:crypto";
import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { open } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { createGunzip } from "node:zlib";
import {
	SELF_BACKUP_LAYOUT,
	SELF_BACKUP_MANIFEST,
} from "#/config/self-backup.ts";
import type { ErrorInfo } from "#/libs/coded.ts";
import { coded } from "#/utils/error.ts";
import { DumpRefused, DumpScriptFilter } from "./dump-check";

/**
 * Reading a Nitrobase self-backup for the first-run restore, on disk and as
 * streams (no archive or dump is held in memory). The archive is what
 * `self-backup.server.ts` writes: openssl-format AES-256-CBC/PBKDF2 over a
 * gzipped tar `<id>-backup/{manifest.json, <id>.sql}` (`#/config/self-backup.ts`).
 * CBC has no
 * MAC, so the sha256 the owner noted is checked BEFORE decrypting (it is
 * computed while the upload is written), the manifest's member checksum
 * after.
 */
export type PanelArchiveProblem =
	| { code: "checksum" }
	| { code: "decrypt" }
	| { code: "too_large" }
	| { code: "archive"; reason: ErrorInfo }
	| { code: "dump"; reason: ErrorInfo };

export class PanelArchiveError extends Error {
	constructor(readonly problem: PanelArchiveProblem) {
		super(
			"reason" in problem
				? `${problem.code}: ${problem.reason.code}`
				: problem.code,
		);
		this.name = "PanelArchiveError";
	}
}

export interface PanelManifest {
	format: number;
	kind: "panel";
	createdAt: string;
	version: string | null;
	members: { path: string; sha256: string; size: number }[];
}

const BLOCK = 512;
const MAGIC = Buffer.from("Salted__");
const MANIFEST_MAX_BYTES = 1024 * 1024;

async function write(stream: Writable, chunk: Buffer): Promise<void> {
	if (!stream.write(chunk)) await once(stream, "drain");
}

async function close(stream: Writable): Promise<void> {
	stream.end();
	await once(stream, "finish");
}

/**
 * Write `body` to `path` (0600), at most `maxBytes`, hashing it on the
 * way. Works for chunked bodies (no Content-Length needed).
 */
export async function receiveToFile(
	body: AsyncIterable<Uint8Array>,
	path: string,
	maxBytes: number,
): Promise<{ bytes: number; sha256: string }> {
	const out = createWriteStream(path, { mode: 0o600 });
	const hash = createHash("sha256");
	let bytes = 0;
	try {
		for await (const chunk of body) {
			bytes += chunk.length;
			if (bytes > maxBytes) throw new PanelArchiveError({ code: "too_large" });
			hash.update(chunk);
			await write(out, Buffer.from(chunk));
		}
	} finally {
		await close(out).catch(() => undefined);
	}
	return { bytes, sha256: hash.digest("hex") };
}

/** Which of the two known members `name` is (else null). */
function memberOf(name: string): "dump" | "manifest" | null {
	const { root, dump } = SELF_BACKUP_LAYOUT;
	if (name === `${root}/${dump}`) return "dump";
	if (name === `${root}/${SELF_BACKUP_MANIFEST}`) return "manifest";
	return null;
}

/**
 * Streaming tar reader for the two known members: the dump goes to
 * `dumpPath` (hashed), the manifest stays in memory (small). Anything else
 * is skipped; links, devices and unknown paths are ignored.
 */
async function extractTar(
	source: AsyncIterable<Buffer>,
	dumpPath: string,
	maxBytes: number,
): Promise<{
	manifest: Buffer;
	dumpSha256: string;
	dumpSize: number;
}> {
	const dump = createWriteStream(dumpPath, { mode: 0o600 });
	const dumpHash: Hash = createHash("sha256");
	let dumpSize = 0;
	let manifest: Buffer | null = null;
	let pending: Buffer = Buffer.alloc(0);
	let total = 0;
	// Current entry: bytes left of its data and of its padding.
	let entry: { name: string; type: string; left: number; pad: number } | null =
		null;
	const manifestParts: Buffer[] = [];
	let longName: string | null = null;
	let longParts: Buffer[] | null = null;
	let ended = false;
	const field = (header: Buffer, start: number, length: number) => {
		const raw = header.subarray(start, start + length);
		const end = raw.indexOf(0);
		return raw.subarray(0, end === -1 ? length : end).toString("utf8");
	};
	try {
		for await (const chunk of source) {
			total += chunk.length;
			if (total > maxBytes) throw new PanelArchiveError({ code: "too_large" });
			pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
			for (;;) {
				if (ended) {
					pending = Buffer.alloc(0);
					break;
				}
				if (!entry) {
					if (pending.length < BLOCK) break;
					const header = pending.subarray(0, BLOCK);
					pending = pending.subarray(BLOCK);
					if (header.every((byte) => byte === 0)) {
						ended = true;
						continue;
					}
					const size = Number.parseInt(field(header, 124, 12).trim() || "0", 8);
					if (!Number.isSafeInteger(size) || size < 0) {
						throw new PanelArchiveError({
							code: "archive",
							reason: coded("ARCHIVE_TAR_HEADER"),
						});
					}
					const prefix = field(header, 345, 155);
					let name = field(header, 0, 100);
					if (prefix) name = `${prefix}/${name}`;
					const type = String.fromCharCode(header[156] || 48);
					if (longName !== null && type !== "L" && type !== "x") {
						name = longName;
						longName = null;
					}
					entry = {
						name: name.replace(/^(\.\/)+/, ""),
						type,
						left: size,
						pad: (BLOCK - (size % BLOCK)) % BLOCK,
					};
					if (type === "L" || type === "x") longParts = [];
					continue;
				}
				if (entry.left > 0) {
					if (pending.length === 0) break;
					const take = pending.subarray(
						0,
						Math.min(entry.left, pending.length),
					);
					pending = pending.subarray(take.length);
					entry.left -= take.length;
					const regular = entry.type === "0" || entry.type === "\0";
					const known = regular ? memberOf(entry.name) : null;
					if (longParts) longParts.push(Buffer.from(take));
					else if (known === "dump") {
						dumpHash.update(take);
						dumpSize += take.length;
						await write(dump, Buffer.from(take));
					} else if (known === "manifest") {
						manifestParts.push(Buffer.from(take));
						if (
							manifestParts.reduce((n, part) => n + part.length, 0) >
							MANIFEST_MAX_BYTES
						) {
							throw new PanelArchiveError({
								code: "archive",
								reason: coded("ARCHIVE_PANEL_MANIFEST_TOO_LARGE"),
							});
						}
					}
					continue;
				}
				if (entry.pad > 0) {
					if (pending.length === 0) break;
					const skip = Math.min(entry.pad, pending.length);
					pending = pending.subarray(skip);
					entry.pad -= skip;
					continue;
				}
				// Entry done.
				if (longParts) {
					const text = Buffer.concat(longParts).toString("utf8");
					longName =
						entry.type === "L"
							? text.replace(/\0+$/, "")
							: (/\d+ path=([^\n]*)\n/.exec(text)?.[1] ?? null);
					longParts = null;
				}
				if (
					entry.type !== "L" &&
					entry.type !== "x" &&
					memberOf(entry.name) === "manifest"
				) {
					manifest = Buffer.concat(manifestParts);
				}
				entry = null;
			}
		}
	} finally {
		await close(dump).catch(() => undefined);
	}
	if (entry && (entry.left > 0 || entry.pad > 0)) {
		throw new PanelArchiveError({
			code: "archive",
			reason: coded("ARCHIVE_TRUNCATED"),
		});
	}
	if (!manifest || dumpSize === 0) {
		throw new PanelArchiveError({
			code: "archive",
			reason: coded("ARCHIVE_PANEL_MEMBERS_MISSING"),
		});
	}
	return { manifest, dumpSha256: dumpHash.digest("hex"), dumpSize };
}

/** Decrypt (openssl format) and gunzip `file` as one stream. */
async function decryptedStream(
	file: string,
	key: string,
	iterations: number,
): Promise<Readable> {
	const handle = await open(file, "r");
	const head = Buffer.alloc(16);
	try {
		await handle.read(head, 0, 16, 0);
	} finally {
		await handle.close();
	}
	if (!head.subarray(0, 8).equals(MAGIC)) {
		throw new PanelArchiveError({ code: "decrypt" });
	}
	const derived = pbkdf2Sync(
		key,
		head.subarray(8, 16),
		iterations,
		48,
		"sha256",
	);
	const decipher = createDecipheriv(
		"aes-256-cbc",
		derived.subarray(0, 32),
		derived.subarray(32, 48),
	);
	const gunzip = createGunzip();
	const input = createReadStream(file, { start: 16 });
	// Wrong key: bad padding at the end or a gzip header error.
	const fail = (error: Error) => gunzip.destroy(error);
	input.on("error", fail);
	decipher.on("error", fail);
	return input.pipe(decipher).pipe(gunzip);
}

/**
 * Verify and unpack a self-backup on disk. `sha256` is the upload's hash
 * (computed while it was received), `expectedSha256` the one the owner
 * noted; `key` the ENCRYPTION_KEY of the installation that made it.
 */
export async function readPanelArchive(input: {
	file: string;
	sha256: string;
	expectedSha256: string;
	key: string;
	iterations: number;
	/** Largest unpacked size (decompression bombs stop here). */
	maxBytes: number;
	dumpPath: string;
}): Promise<{ manifest: PanelManifest }> {
	const expected = input.expectedSha256.trim().toLowerCase();
	if (!/^[0-9a-f]{64}$/.test(expected) || input.sha256 !== expected) {
		throw new PanelArchiveError({ code: "checksum" });
	}
	let extracted: Awaited<ReturnType<typeof extractTar>>;
	try {
		extracted = await extractTar(
			await decryptedStream(input.file, input.key, input.iterations),
			input.dumpPath,
			input.maxBytes,
		);
	} catch (error) {
		if (error instanceof PanelArchiveError) throw error;
		throw new PanelArchiveError({ code: "decrypt" });
	}
	let manifest: PanelManifest;
	try {
		manifest = JSON.parse(extracted.manifest.toString("utf8")) as PanelManifest;
	} catch {
		throw new PanelArchiveError({
			code: "archive",
			reason: coded("ARCHIVE_MANIFEST_INVALID"),
		});
	}
	if (manifest.format !== 1 || manifest.kind !== "panel") {
		throw new PanelArchiveError({
			code: "archive",
			reason: coded("ARCHIVE_NOT_PANEL_BACKUP"),
		});
	}
	const member = manifest.members?.find(
		(item) => item.path === SELF_BACKUP_LAYOUT.dump,
	);
	if (
		!member ||
		member.sha256 !== extracted.dumpSha256 ||
		member.size !== extracted.dumpSize
	) {
		throw new PanelArchiveError({
			code: "archive",
			reason: coded("ARCHIVE_PANEL_DUMP_MISMATCH"),
		});
	}
	return { manifest };
}

/**
 * Check the dump line by line and write the script psql loads: preamble,
 * the allowed dump lines, postamble. Throws PanelArchiveError("dump").
 */
export async function writeRestoreScript(input: {
	dumpPath: string;
	scriptPath: string;
	preamble: string;
	postamble: string;
	maxStatementBytes: number;
}): Promise<void> {
	const out = createWriteStream(input.scriptPath, { mode: 0o600 });
	const filter = new DumpScriptFilter(input.maxStatementBytes);
	const lines = createInterface({
		input: createReadStream(input.dumpPath, { encoding: "utf8" }),
		crlfDelay: Number.POSITIVE_INFINITY,
	});
	try {
		await write(out, Buffer.from(input.preamble));
		for await (const line of lines) {
			const kept = filter.line(line);
			if (kept !== null) await write(out, Buffer.from(`${kept}\n`));
		}
		filter.end();
		await write(out, Buffer.from(input.postamble));
	} catch (error) {
		if (error instanceof DumpRefused) {
			throw new PanelArchiveError({ code: "dump", reason: error.reason });
		}
		throw error;
	} finally {
		lines.close();
		await close(out).catch(() => undefined);
	}
}
