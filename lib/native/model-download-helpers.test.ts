import { deriveDownloadLabel, formatBytes, isDownloadInFlight } from "./model-download-helpers"
import type { ModelDownloadProgress } from "./model-download"

describe("formatBytes", () => {
  test("returns '0 B' for non-positive or non-finite inputs", () => {
    expect(formatBytes(0)).toBe("0 B")
    expect(formatBytes(-1)).toBe("0 B")
    expect(formatBytes(Number.NaN)).toBe("0 B")
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("0 B")
  })

  test("uses B with no decimals for sub-KB values", () => {
    expect(formatBytes(1)).toBe("1 B")
    expect(formatBytes(512)).toBe("512 B")
    expect(formatBytes(1023)).toBe("1023 B")
  })

  test("scales through KB / MB / GB / TB (1 decimal when value < 10)", () => {
    expect(formatBytes(2 * 1024)).toBe("2.0 KB")
    expect(formatBytes(2 * 1024 * 1024)).toBe("2.0 MB")
    expect(formatBytes(2 * 1024 ** 3)).toBe("2.0 GB")
    expect(formatBytes(2 * 1024 ** 4)).toBe("2.0 TB")
  })

  test("uses 0 decimals once the unit's value is >= 10", () => {
    expect(formatBytes(10 * 1024)).toBe("10 KB")
    expect(formatBytes(123 * 1024 * 1024)).toBe("123 MB")
  })

  test("keeps one decimal between 1 and <10 of the chosen unit", () => {
    expect(formatBytes(1536)).toBe("1.5 KB")
    expect(formatBytes(1024 * 9.5)).toBe("9.5 KB")
  })

  test("caps at the largest unit (TB) for huge inputs", () => {
    expect(formatBytes(2048 * 1024 ** 4)).toBe("2048 TB")
  })
})

describe("deriveDownloadLabel", () => {
  const base: Omit<ModelDownloadProgress, "status"> = {
    modelId: "m",
    bytesDownloaded: 0,
    bytesTotal: 0,
    percentage: 0,
  }

  test("returns empty string when progress is undefined", () => {
    expect(deriveDownloadLabel(undefined)).toBe("")
  })

  test("emits the documented label per status", () => {
    expect(deriveDownloadLabel({ ...base, status: "pending" })).toBe("Queued")
    expect(deriveDownloadLabel({ ...base, status: "downloading", percentage: 42.7 })).toBe("43%")
    expect(deriveDownloadLabel({ ...base, status: "completed" })).toBe("Installed")
    expect(deriveDownloadLabel({ ...base, status: "cancelled" })).toBe("Cancelled")
    expect(deriveDownloadLabel({ ...base, status: "error" })).toBe("Error")
    expect(deriveDownloadLabel({ ...base, status: "error", error: "boom" })).toBe("Error: boom")
  })

  test("returns empty string for unknown statuses", () => {
    expect(
      deriveDownloadLabel({ ...base, status: "weird" as ModelDownloadProgress["status"] })
    ).toBe("")
  })
})

describe("isDownloadInFlight", () => {
  const base: Omit<ModelDownloadProgress, "status"> = {
    modelId: "m",
    bytesDownloaded: 0,
    bytesTotal: 0,
    percentage: 0,
  }

  test("true for pending / downloading", () => {
    expect(isDownloadInFlight({ ...base, status: "pending" })).toBe(true)
    expect(isDownloadInFlight({ ...base, status: "downloading" })).toBe(true)
  })

  test("false for terminal states and undefined", () => {
    expect(isDownloadInFlight(undefined)).toBe(false)
    expect(isDownloadInFlight({ ...base, status: "completed" })).toBe(false)
    expect(isDownloadInFlight({ ...base, status: "cancelled" })).toBe(false)
    expect(isDownloadInFlight({ ...base, status: "error" })).toBe(false)
  })
})
