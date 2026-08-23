import { readFileSync } from "node:fs"
import { join } from "node:path"

import { SDK_PACKAGE_NAME, SDK_VERSION } from "./version"

const manifest = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as {
  name: string
  version: string
}

describe("generated version constants", () => {
  it("matches package.json — run scripts/sync-version.mjs if this fails", () => {
    expect(SDK_VERSION).toBe(manifest.version)
    expect(SDK_PACKAGE_NAME).toBe(manifest.name)
  })

  it("is a real semver string and never the placeholder that used to be hardcoded", () => {
    expect(SDK_VERSION).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/)
  })
})
