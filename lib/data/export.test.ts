jest.mock("./build-package", () => ({
  buildBackupPackage: jest.fn(async () => ({ kind: "pkg" })),
  defaultExportFileName: jest.fn(() => "name.json"),
  serializePackage: jest.fn(() => "serialized"),
}))

import {
  buildExportEnvelope,
  defaultExportFileName,
  serializePackage,
  buildBackupPackage,
} from "./export"
import * as buildPackage from "./build-package"

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
})
