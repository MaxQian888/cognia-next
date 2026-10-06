import { readFileSync } from "node:fs"
import { join } from "node:path"

import packageJson from "@/packages/plugin-sdk/package.json"

import {
  loadEffortSurfaceModule,
  loadPluginI18nModule,
  PLUGIN_SDK_SUBPATH_LOADERS,
} from "./sdk-subpath-loaders"

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

jest.mock("@/lib/ai/effort-surface-session", () => ({
  effortSurfaceForSession: jest.fn(() => ({ marker: "host-snapshot" })),
  subscribeEffortSurface: jest.fn(() => () => undefined),
}))
jest.mock("@/lib/plugin/api/use-plugin-translations", () => ({
  usePluginTranslations: jest.fn(() => (key: string) => `host:${key}`),
}))

test("host loaders bind runtime ports before publishing only author exports", async () => {
  const effort = await loadEffortSurfaceModule()
  expect(effort.effortSurfaceForSession({ id: "fixture" })).toEqual({ marker: "host-snapshot" })
  expect(effort).not.toHaveProperty("bindEffortSurfaceHost")
  const i18n = await loadPluginI18nModule()
  expect(i18n.usePluginTranslations("fixture")("hello")).toBe("host:hello")
  expect(i18n).not.toHaveProperty("bindPluginTranslationsHost")
  expect(typeof i18n.registerPluginI18n).toBe("function")
})

test("loads the pet API against the host contribution registries", async () => {
  const loaded = await PLUGIN_SDK_SUBPATH_LOADERS["@cognia/plugin-sdk/api/pet"]()
  const host = await import("@cognia/plugin-sdk/api/pet")
  expect(loaded).toEqual(host)
  expect(typeof host.definePetItem).toBe("function")
  const cliTsconfig = readFileSync(join(__dirname, "../../../cli/tsconfig.json"), "utf8")
  expect(cliTsconfig).toContain('"@cognia/plugin-sdk/api/pet"')
})
