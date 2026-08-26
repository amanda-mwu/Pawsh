/**
 * Build a `multipart/form-data` body carrying a metadata field followed by one file.
 *
 * Every Pawsh upload route reads its metadata field first and refuses to touch the file until it
 * has one, so the order here is part of the contract rather than a convenience. The separators
 * must be CRLF: a body assembled with bare newlines is rejected by the parser as truncated, which
 * is a confusing way to discover you have written the fixture wrong.
 */
export function multipartUpload(input: {
  metadata: unknown;
  file: Buffer;
  filename: string;
  contentType: string;
}): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `pawsh-${crypto.randomUUID()}`;
  const CRLF = "\r\n";
  const prefix = Buffer.from(
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="metadata"${CRLF}${CRLF}` +
    `${JSON.stringify(input.metadata)}${CRLF}` +
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="file"; filename="${input.filename}"${CRLF}` +
    `Content-Type: ${input.contentType}${CRLF}${CRLF}`
  );
  return {
    payload: Buffer.concat([prefix, input.file, Buffer.from(`${CRLF}--${boundary}--${CRLF}`)]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` }
  };
}

/**
 * The same, for routes that take the file on its own with no metadata part.
 */
export function multipartFile(input: {
  file: Buffer;
  filename: string;
  contentType: string;
}): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `pawsh-${crypto.randomUUID()}`;
  const CRLF = "\r\n";
  const prefix = Buffer.from(
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="file"; filename="${input.filename}"${CRLF}` +
    `Content-Type: ${input.contentType}${CRLF}${CRLF}`
  );
  return {
    payload: Buffer.concat([prefix, input.file, Buffer.from(`${CRLF}--${boundary}--${CRLF}`)]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` }
  };
}
