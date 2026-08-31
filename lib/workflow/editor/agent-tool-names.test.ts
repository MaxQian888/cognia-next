import {
  SDK_NATIVE_MUTATING_TOOL_NAMES,
  SDK_NATIVE_READONLY_TOOL_NAMES,
  SDK_NATIVE_TOOL_NAMES,
} from "./agent-tool-names"
import { RESTRICTED_MODE_DENIED_TOOLS } from "@/lib/workspace/restricted-tools"

describe("SDK native tool names", () => {
  it("lists both halves with no overlap", () => {
    const overlap = SDK_NATIVE_READONLY_TOOL_NAMES.filter((n) =>
      (SDK_NATIVE_MUTATING_TOOL_NAMES as readonly string[]).includes(n)
    )
    expect(overlap).toEqual([])
    expect(SDK_NATIVE_TOOL_NAMES.length).toBe(
      SDK_NATIVE_READONLY_TOOL_NAMES.length + SDK_NATIVE_MUTATING_TOOL_NAMES.length
    )
  })

  /**
   * The mutating half is the same set Restricted Mode denies. Two hand-kept
   * copies of a list nobody can derive is exactly how the previous version of
   * `restricted-tools.ts` missed 23 mutators.
   */
  it("agrees with Restricted Mode about which SDK tools mutate", () => {
    for (const name of SDK_NATIVE_MUTATING_TOOL_NAMES) {
      expect(RESTRICTED_MODE_DENIED_TOOLS).toContain(name)
    }
    for (const name of SDK_NATIVE_READONLY_TOOL_NAMES) {
      expect(RESTRICTED_MODE_DENIED_TOOLS).not.toContain(name)
    }
  })
})
