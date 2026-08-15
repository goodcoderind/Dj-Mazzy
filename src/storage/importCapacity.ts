export const IMPORT_STORAGE_RESERVE_BYTES = 128 * 1024 * 1024;

export type StorageEstimate = { quota?: number; usage?: number } | null | undefined;

export type ImportCapacity = {
  status: "fits" | "too-large" | "unknown";
  importBytes: number;
  availableBytes: number | null;
  requiredBytes: number;
};

export const assessImportCapacity = (
  fileSizes: number[],
  estimate: StorageEstimate,
  reserveBytes = IMPORT_STORAGE_RESERVE_BYTES
): ImportCapacity => {
  const importBytes = fileSizes.reduce(
    (sum, value) => sum + (Number.isFinite(value) && value >= 0 ? value : 0),
    0
  );
  const quota = Number(estimate?.quota);
  const usage = Number(estimate?.usage);
  const reserve = Number.isFinite(reserveBytes) && reserveBytes >= 0 ? reserveBytes : IMPORT_STORAGE_RESERVE_BYTES;
  if (!Number.isFinite(quota) || quota <= 0 || !Number.isFinite(usage) || usage < 0 || usage > quota) {
    return { status: "unknown", importBytes, availableBytes: null, requiredBytes: importBytes + reserve };
  }
  const availableBytes = Math.max(0, quota - usage);
  const requiredBytes = importBytes + reserve;
  return {
    status: requiredBytes <= availableBytes ? "fits" : "too-large",
    importBytes,
    availableBytes,
    requiredBytes
  };
};

export const formatStorageSize = (bytes: number | null) => {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "unknown";
  const gib = bytes / (1024 ** 3);
  if (gib >= 1) return `${gib.toFixed(gib >= 10 ? 0 : 1)} GB`;
  return `${Math.max(1, Math.round(bytes / (1024 ** 2)))} MB`;
};
