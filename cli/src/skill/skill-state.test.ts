/**
 * @jest-environment node
 */
import { readEnabled, setEnabled, skillStatePath, type SkillStateFs } from "./skill-state"

function memFs(seed: Record<string, string> = {}): SkillStateFs {
  const files = { ...seed }
  return {
    exists: (p) => p in files,
    readText: (p) => files[p],
    writeText: (p, data) => {
      files[p] = data
    },
  }
}

describe("skill enablement state", () => {
  it("returns empty when no file exists", () => {
    expect(readEnabled("/home", memFs())).toEqual(new Set())
  })

  it("reads the enabled list", () => {
    const fs = memFs({ [skillStatePath("/home")]: JSON.stringify({ enabled: ["a", "b"] }) })
    expect([...readEnabled("/home", fs)].sort()).toEqual(["a", "b"])
  })

  it("tolerates corrupt state", () => {
    const fs = memFs({ [skillStatePath("/home")]: "}{" })
    expect(readEnabled("/home", fs)).toEqual(new Set())
  })

  it("adds then removes an id, persisting", () => {
    const fs = memFs()
    setEnabled("/home", "s1", true, fs)
    expect(readEnabled("/home", fs).has("s1")).toBe(true)
    setEnabled("/home", "s1", false, fs)
    expect(readEnabled("/home", fs).has("s1")).toBe(false)
  })
})
