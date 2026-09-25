import { readFileSync } from "node:fs"
import { join } from "node:path"

import packageJson from "@/packages/plugin-sdk/package.json"

import { PLUGIN_SDK_SUBPATH_LOADERS } from "./sdk-subpath-loaders"

// `testing` is published for plugin test suites and must never ship in a
// runtime bundle, so the loader deliberately refuses it.
const TEST_ONLY_SUBPATHS = new Set(["./testing"])

const published = Object.keys(packageJson.exports)
  .filter((key) => key !== "." && key !== "./package.json" && !TEST_ONLY_SUBPATHS.has(key))
  .map((key) => `@cognia/plugin-sdk/${key.slice(2)}`)
  .sort()

describe("PLUGIN_SDK_SUBPATH_LOADERS", () => {
  it("has a loader for exactly the subpaths the SDK publishes", () => {
    expect(Object.keys(PLUGIN_SDK_SUBPATH_LOADERS).sort()).toEqual(published)
  })

  it("can resolve every subpath in the host build (a tsconfig path per subpath)", () => {
    const tsconfig = readFileSync(join(__dirname, "../../../tsconfig.json"), "utf8")
    const unresolvable = published.filter((specifier) => !tsconfig.includes(`"${specifier}"`))
    expect(unresolvable).toEqual([])
  })
})
