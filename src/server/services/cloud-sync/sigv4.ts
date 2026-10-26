import { createHash, createHmac } from "node:crypto";

/**
 * AWS Signature Version 4 for one bodyless S3 request (the connection
 * test's ListBuckets). Transfers themselves go through rclone.
 */

const sha256 = (data: string) =>
	createHash("sha256").update(data).digest("hex");
const hmac = (key: Buffer | string, data: string) =>
	createHmac("sha256", key).update(data).digest();

/** RFC 3986 encoding of a query/path component (AWS rules). */
const encode = (value: string) =>
	encodeURIComponent(value).replace(
		/[!'()*]/g,
		(char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
	);

export interface SignInput {
	method: "GET" | "HEAD";
	url: URL;
	region: string;
	accessKeyId: string;
	secretAccessKey: string;
	/** Fixed clock for tests. */
	now?: Date;
}

/** Headers to send (host, x-amz-date, x-amz-content-sha256, authorization). */
export function signS3Request(input: SignInput): Record<string, string> {
	const service = "s3";
	const now = input.now ?? new Date();
	const amzDate = now
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}/, "");
	const day = amzDate.slice(0, 8);
	const payloadHash = sha256("");
	const host = input.url.host;
	const canonicalPath = input.url.pathname
		.split("/")
		.map((segment) => encode(decodeURIComponent(segment)))
		.join("/");
	const query = [...input.url.searchParams.entries()]
		.map(([key, value]) => [encode(key), encode(value)] as const)
		.sort(([a, x], [b, y]) => (a === b ? x.localeCompare(y) : a < b ? -1 : 1))
		.map(([key, value]) => `${key}=${value}`)
		.join("&");
	const headers: Record<string, string> = {
		host,
		"x-amz-content-sha256": payloadHash,
		"x-amz-date": amzDate,
	};
	const signedHeaders = Object.keys(headers).sort().join(";");
	const canonicalHeaders = Object.keys(headers)
		.sort()
		.map((name) => `${name}:${headers[name]}\n`)
		.join("");
	const canonicalRequest = [
		input.method,
		canonicalPath || "/",
		query,
		canonicalHeaders,
		signedHeaders,
		payloadHash,
	].join("\n");
	const scope = `${day}/${input.region}/${service}/aws4_request`;
	const stringToSign = [
		"AWS4-HMAC-SHA256",
		amzDate,
		scope,
		sha256(canonicalRequest),
	].join("\n");
	const signingKey = hmac(
		hmac(
			hmac(hmac(`AWS4${input.secretAccessKey}`, day), input.region),
			service,
		),
		"aws4_request",
	);
	const signature = createHmac("sha256", signingKey)
		.update(stringToSign)
		.digest("hex");
	return {
		"x-amz-content-sha256": payloadHash,
		"x-amz-date": amzDate,
		authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
	};
}

/** Bucket names of a ListBuckets XML answer. */
export function parseBucketNames(xml: string): string[] {
	return [...xml.matchAll(/<Bucket>[\s\S]*?<Name>([^<]*)<\/Name>/g)].map(
		(match) => match[1] ?? "",
	);
}
