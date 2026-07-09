import { resolveEffectiveCwd } from "./effective-cwd"
import type { WorkspaceRoot } from "@/types/workspace"

const roots: WorkspaceRoot[] = [
  { id: "r2", path: "/extra" },
  { id: "r1", path: "/workspace/main", isPrimary: true },
]

describe("resolveEffectiveCwd", () => {
  it("prefers the per-session override over everything else", () => {
    expect(
      resolveEffectiveCwd({
        sessionWorkingDir: "/session/dir",
        activeProject: { roots },
        characterWorkingDir: "/char",
        defaultWorkingDir: "/default",
      })
    ).toBe("/session/dir")
  })

  it("falls back to the active workspace primary root", () => {
    expect(
      resolveEffectiveCwd({
        activeProject: { roots },
        characterWorkingDir: "/char",
        defaultWorkingDir: "/default",
      })
    ).toBe("/workspace/main")
  })

  it("uses the first root when none is flagged primary", () => {
    expect(
      resolveEffectiveCwd({
        activeProject: { roots: [{ id: "a", path: "/only" }] },
      })
    ).toBe("/only")
  })

  it("skips a rootless workspace and falls through to the character default", () => {
    expect(
      resolveEffectiveCwd({
        activeProject: { roots: [] },
        characterWorkingDir: "/char",
        defaultWorkingDir: "/default",
      })
    ).toBe("/char")
  })

  it("falls back to the app default working dir last", () => {
    expect(resolveEffectiveCwd({ defaultWorkingDir: "/default" })).toBe("/default")
  })

  it("returns undefined when nothing is configured", () => {
    expect(resolveEffectiveCwd({})).toBeUndefined()
    expect(resolveEffectiveCwd({ activeProject: null })).toBeUndefined()
  })

  it("treats blank / whitespace-only values as unset", () => {
    expect(
      resolveEffectiveCwd({
        sessionWorkingDir: "  ",
        activeProject: { roots: [{ id: "a", path: "   ", isPrimary: true }] },
        characterWorkingDir: "",
        defaultWorkingDir: "\t",
      })
    ).toBeUndefined()
  })

  it("trims the resolved path", () => {
    expect(resolveEffectiveCwd({ sessionWorkingDir: " /padded " })).toBe("/padded")
  })
})
