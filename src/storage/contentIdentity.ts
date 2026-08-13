export const FILE_CONTENT_IDENTITY_SCHEMA_VERSION = "file-content-sha256/v1" as const;
const CONTENT_IDENTITY_PATTERN = /^file-content-sha256\/v1:[a-f0-9]{64}$/;

export const normalizeContentIdentity = (value: unknown) =>
  typeof value === "string" && CONTENT_IDENTITY_PATTERN.test(value) ? value : null;

export const identifyLocalFile = async (file: Pick<File, "arrayBuffer">) => {
  const bytes = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  return `${FILE_CONTENT_IDENTITY_SCHEMA_VERSION}:${hex}`;
};
