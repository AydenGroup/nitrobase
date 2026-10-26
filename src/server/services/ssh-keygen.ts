import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_ID } from "#/config/shared.ts";
import { type SSHKeyType, sshKeyTypes } from "#/config/ssh-key-types.ts";
import { AppError } from "#/utils/error.ts";

/** A new, unencrypted key pair (OpenSSH formats). */
export interface GeneratedSSHKey {
	keyType: SSHKeyType;
	privateKey: string;
	publicKey: string;
}

/** Spawns without a shell; rejects with stderr on a non-zero exit. */
function run(cmd: string, args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const proc = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		proc.stderr.on("data", (d) => {
			stderr += d.toString();
		});
		proc.on("error", reject);
		proc.on("close", (code) => {
			if (code === 0) resolve();
			else {
				reject(
					new AppError("SSH_KEYGEN_FAILED", {
						code: code ?? -1,
						detail: stderr,
					}),
				);
			}
		});
	});
}

/**
 * Generates a key pair with the system `ssh-keygen` (must be installed) in
 * a private temp dir, which is always removed. Algorithm and size come from
 * the `sshKeyTypes` registry. No passphrase is set; the caller encrypts the
 * private key before storing it and never sends it to the browser.
 */
export async function generateSSHKey(
	type: SSHKeyType,
	comment = APP_ID,
): Promise<GeneratedSSHKey> {
	const dir = await fs.mkdtemp(join(tmpdir(), "ssh-key-"));
	const path = join(dir, "id_key");

	const args = [
		...sshKeyTypes[type].keygenArgs,
		"-C",
		comment,
		"-f",
		path,
		"-N",
		"",
		"-q",
	];

	try {
		await run("ssh-keygen", args);
		const privateKey = await fs.readFile(path, "utf-8");
		const publicKey = await fs.readFile(`${path}.pub`, "utf-8");
		return { keyType: type, privateKey, publicKey: publicKey.trim() };
	} finally {
		await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
	}
}
