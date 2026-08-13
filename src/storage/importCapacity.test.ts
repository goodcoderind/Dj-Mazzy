import { describe, expect, it } from "vitest";
import { assessImportCapacity, formatStorageSize } from "./importCapacity";

describe("import capacity", () => {
  it("keeps a reserve after counting every selected audio byte", () => {
    expect(assessImportCapacity([100, 200], { quota: 1000, usage: 400 }, 250)).toEqual({
      status: "fits",
      importBytes: 300,
      availableBytes: 600,
      requiredBytes: 550
    });
    expect(assessImportCapacity([100, 200], { quota: 1000, usage: 500 }, 250).status).toBe("too-large");
  });

  it("fails open only to an explicit unknown state when the browser estimate is malformed", () => {
    expect(assessImportCapacity([1024], null).status).toBe("unknown");
    expect(assessImportCapacity([1024], { quota: Infinity, usage: 0 }).status).toBe("unknown");
    expect(assessImportCapacity([1024], { quota: 100, usage: 101 }).status).toBe("unknown");
  });

  it("ignores malformed file sizes and formats only coarse local capacity", () => {
    expect(assessImportCapacity([100, -5, Number.NaN], { quota: 1000, usage: 0 }, 0).importBytes).toBe(100);
    expect(formatStorageSize(1536 * 1024 * 1024)).toBe("1.5 GB");
    expect(formatStorageSize(10 * 1024 * 1024)).toBe("10 MB");
    expect(formatStorageSize(null)).toBe("unknown");
  });
});
