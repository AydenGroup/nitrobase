import { AppError, internalError } from "#/utils/error.ts";

/** One part of a multipart body. */
export interface MultipartPart {
	/** Lower-cased header names. */
	headers: Record<string, string>;
	/** Content-Disposition `name`. */
	name: string | null;
	/** Content-Disposition `filename`. */
	filename: string | null;
	data: Buffer;
}

/** `multipart/form-data; boundary=…` → the boundary (null: not multipart). */
export function multipartBoundary(contentType: string | undefined) {
	if (!contentType || !/^multipart\//i.test(contentType.trim())) return null;
	const match = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
	return match ? (match[1] ?? match[2] ?? null) : null;
}

/** A Content-Disposition parameter (quoted or bare). */
function dispositionParam(value: string, name: string): string | null {
	const match = new RegExp(`(?:^|;)\\s*${name}="((?:[^"\\\\]|\\\\.)*)"`, "i")
		.exec(value)
		?.at(1);
	if (match !== undefined) return match.replace(/\\(.)/g, "$1");
	return (
		new RegExp(`(?:^|;)\\s*${name}=([^;\\s]+)`, "i").exec(value)?.[1] ?? null
	);
}

/** A form part to send: a field (no filename) or a file. */
export interface FormPart {
	name: string;
	filename?: string;
	contentType?: string;
	data: string | Buffer;
}

/** Quote a Content-Disposition parameter (no CR/LF; `"` and `\` escaped). */
const quoteParam = (value: string) =>
	`"${value.replace(/[\r\n]/g, "").replace(/(["\\])/g, "\\$1")}"`;

/** `multipart/form-data` body of `parts` (RFC 7578, CRLF framing). */
export function buildMultipart(parts: FormPart[], boundary: string): Buffer {
	if (!/^[A-Za-z0-9'()+_,./:=?-]{1,70}$/.test(boundary)) {
		throw internalError(`Invalid multipart boundary "${boundary}"`);
	}
	const chunks: Buffer[] = [];
	for (const part of parts) {
		const headers = [
			`Content-Disposition: form-data; name=${quoteParam(part.name)}${
				part.filename !== undefined
					? `; filename=${quoteParam(part.filename)}`
					: ""
			}`,
			...(part.contentType ? [`Content-Type: ${part.contentType}`] : []),
		];
		chunks.push(
			Buffer.from(`--${boundary}\r\n${headers.join("\r\n")}\r\n\r\n`),
			Buffer.isBuffer(part.data) ? part.data : Buffer.from(part.data),
			Buffer.from("\r\n"),
		);
	}
	chunks.push(Buffer.from(`--${boundary}--\r\n`));
	return Buffer.concat(chunks);
}

const invalid = (detail: string) =>
	new AppError("CLOUD_API_INVALID_RESPONSE", { detail });

/** Split a multipart body into parts (RFC 7578 framing, CRLF lines). */
export function parseMultipart(
	body: Buffer,
	boundary: string,
): MultipartPart[] {
	const delimiter = Buffer.from(`--${boundary}`);
	const parts: MultipartPart[] = [];
	let position = body.indexOf(delimiter);
	if (position < 0) throw invalid("multipart boundary not found");
	for (;;) {
		position += delimiter.length;
		// "--" after a delimiter closes the body.
		if (body.subarray(position, position + 2).toString() === "--") break;
		const headerStart = body.indexOf("\r\n", position);
		if (headerStart < 0) throw invalid("truncated multipart body");
		const headerEnd = body.indexOf("\r\n\r\n", headerStart);
		if (headerEnd < 0) throw invalid("truncated multipart headers");
		const next = body.indexOf(Buffer.from(`\r\n--${boundary}`), headerEnd + 4);
		if (next < 0) throw invalid("unterminated multipart part");
		const headers: Record<string, string> = {};
		for (const line of body
			.subarray(headerStart + 2, headerEnd)
			.toString("utf8")
			.split("\r\n")) {
			const colon = line.indexOf(":");
			if (colon <= 0) continue;
			headers[line.slice(0, colon).trim().toLowerCase()] = line
				.slice(colon + 1)
				.trim();
		}
		const disposition = headers["content-disposition"] ?? "";
		parts.push({
			headers,
			name: dispositionParam(disposition, "name"),
			filename: dispositionParam(disposition, "filename"),
			data: body.subarray(headerEnd + 4, next),
		});
		position = next + 2;
	}
	return parts;
}
