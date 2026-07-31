import {
  __resetHeadlessRuntimesForTesting,
  listHeadlessRuntimes,
  registerHeadlessRuntime,
} from "./registry"
import type { HeadlessRuntime } from "./types"

function runtime(name: string): HeadlessRuntime {
  return { name, hosts: ["brain"], start: () => undefined }
}

describe("headless runtime registry", () => {
  beforeEach(() => __resetHeadlessRuntimesForTesting())

  it("registers and lists runtimes in order", () => {
    registerHeadlessRuntime(runtime("a"))
    registerHeadlessRuntime(runtime("b"))
    expect(listHeadlessRuntimes().map((r) => r.name)).toEqual(["a", "b"])
  })

  it("throws on a duplicate name", () => {
    registerHeadlessRuntime(runtime("dup"))
    expect(() => registerHeadlessRuntime(runtime("dup"))).toThrow(/"dup" is already registered/)
  })

  it("throws on an empty name", () => {
    expect(() => registerHeadlessRuntime(runtime("  "))).toThrow(/non-empty name/)
  })
})
