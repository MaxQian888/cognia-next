import { FILES_SHARE_DORMANCY, isFilesShareAvailable } from "./share"

describe("Files sharing dormancy (ADR-0223 §10)", () => {
  it("is unavailable until ADR-0222 file snapshots exist", () => {
    expect(isFilesShareAvailable()).toBe(false)
  })

  it("documents why and what to do instead", () => {
    expect(FILES_SHARE_DORMANCY).toEqual({
      surface: "files-share",
      reason: "awaiting-adr-0222-file-snapshots",
      remedy: "download",
    })
  })
})
