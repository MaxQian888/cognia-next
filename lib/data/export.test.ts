jest.mock("./build-package", () => ({
  buildBackupPackage: jest.fn(async () => ({ kind: "pkg" })),
  defaultExportFileName: jest.fn(() => "name.json"),
  serializePackage: jest.fn(() => "serialized"),
}))
jest.mock("./build-stream", () => ({
  buildBackupStream: jest.fn(),
  buildBackupSections: jest.fn(),
}))
jest.mock("./stream-format", () => ({ readBackupStream: jest.fn() }))

import {
  buildExportEnvelope,
  defaultExportFileName,
  serializePackage,
  buildBackupPackage,
  buildBackupStream,
  buildBackupSections,
  readBackupStream,
} from "./export"
import * as buildPackage from "./build-package"
import * as buildStream from "./build-stream"
import * as streamFormat from "./stream-format"

describe("export facade", () => {
  it("delegates buildExportEnvelope to buildBackupPackage", async () => {
    const result = await buildExportEnvelope({ includeSessions: false, includeApiKey: false })
    expect(buildPackage.buildBackupPackage).toHaveBeenCalledWith({
      includeSessions: false,
      includeApiKey: false,
    })
    expect(result).toEqual({ kind: "pkg" })
  })

  it("re-exports the helpers from build-package", () => {
    expect(defaultExportFileName).toBe(buildPackage.defaultExportFileName)
    expect(serializePackage).toBe(buildPackage.serializePackage)
    expect(buildBackupPackage).toBe(buildPackage.buildBackupPackage)
  })

  it("exposes the additive v4 streaming seams", () => {
    expect(buildBackupStream).toBe(buildStream.buildBackupStream)
    expect(buildBackupSections).toBe(buildStream.buildBackupSections)
    expect(readBackupStream).toBe(streamFormat.readBackupStream)
  })
})
