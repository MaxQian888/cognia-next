import {
  __resetHeadlessRuntimesForTesting,
  listHeadlessRuntimes,
  registerHeadlessRuntime,
} from "./registry"
import type { HeadlessRuntime } from "./types"

function runtime(name: string): HeadlessRuntime {
  return { name, criticality: "optional", hosts: ["brain"], start: () => undefined }
}

describe("headless runtime registry", () => {
  beforeEach(() => __resetHeadlessRuntimesForTesting())
  afterEach(() => jest.restoreAllMocks())

  it("registers and lists runtimes in order", () => {
    registerHeadlessRuntime(runtime("a"))
    registerHeadlessRuntime(runtime("b"))
    expect(listHeadlessRuntimes().map((r) => r.name)).toEqual(["a", "b"])
  })

  it.each(["test", "production"] as const)("throws on a duplicate name in %s", (nodeEnv) => {
    jest.replaceProperty(process, "env", { ...process.env, NODE_ENV: nodeEnv })
    registerHeadlessRuntime(runtime("dup"))
    expect(() => registerHeadlessRuntime(runtime("dup"))).toThrow(/"dup" is already registered/)
  })

  it("uses the latest definition after a development reload without reordering or starting it", () => {
    jest.replaceProperty(process, "env", { ...process.env, NODE_ENV: "development" })
    registerHeadlessRuntime(runtime("collab-runtime"))
    const other = runtime("other")
    registerHeadlessRuntime(other)
    const replacement = { ...runtime("collab-runtime"), start: jest.fn() }

    registerHeadlessRuntime(replacement)

    const registered = listHeadlessRuntimes()
    expect(registered).toHaveLength(2)
    expect(registered[0]).toBe(replacement)
    expect(registered[1]).toBe(other)
    expect(replacement.start).not.toHaveBeenCalled()
  })

  it.each(["test", "development", "production"] as const)(
    "throws on an empty name in %s",
    (nodeEnv) => {
      jest.replaceProperty(process, "env", { ...process.env, NODE_ENV: nodeEnv })
      expect(() => registerHeadlessRuntime(runtime("  "))).toThrow(/non-empty name/)
    }
  )
})
