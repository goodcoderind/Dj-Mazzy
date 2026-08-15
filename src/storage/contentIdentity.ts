export const FILE_CONTENT_IDENTITY_SCHEMA_VERSION = "file-content-sha256/v1" as const;
const CONTENT_IDENTITY_PATTERN = /^file-content-sha256\/v1:[a-f0-9]{64}$/;

export const normalizeContentIdentity = (value: unknown) =>
  typeof value === "string" && CONTENT_IDENTITY_PATTERN.test(value) ? value : null;

const abortError = () => new DOMException("Local file inspection cancelled", "AbortError");

export const readLocalFileBytes = async (
  file: Pick<File, "arrayBuffer">,
  { signal = null }: { signal?: AbortSignal | null } = {}
) => {
  if (signal?.aborted) throw abortError();
  if (typeof FileReader !== "function") {
    const bytes = await file.arrayBuffer();
    if (signal?.aborted) throw abortError();
    return bytes;
  }
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    let settled = false;
    const finish = (callback: (value?: any) => void, value?: unknown) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      reader.onload = null;
      reader.onerror = null;
      reader.onabort = null;
      callback(value);
    };
    const onAbort = () => {
      try { reader.abort(); } catch { /* The read already settled. */ }
      finish(reject, abortError());
    };
    reader.onload = () => finish(resolve, reader.result);
    reader.onerror = () => finish(reject, reader.error ?? new Error("Local file read failed"));
    reader.onabort = () => finish(reject, abortError());
    signal?.addEventListener("abort", onAbort, { once: true });
    reader.readAsArrayBuffer(file as Blob);
  });
};

export const identifyLocalFile = async (
  file: Pick<File, "arrayBuffer">,
  { signal = null, bytes = null }: { signal?: AbortSignal | null; bytes?: ArrayBuffer | null } = {}
) => {
  const fileBytes = bytes ?? await readLocalFileBytes(file, { signal });
  if (signal?.aborted) throw abortError();
  const digest = await crypto.subtle.digest("SHA-256", fileBytes);
  if (signal?.aborted) throw abortError();
  const hex = [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  return `${FILE_CONTENT_IDENTITY_SCHEMA_VERSION}:${hex}`;
};
