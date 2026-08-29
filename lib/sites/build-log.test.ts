import {
  SITE_BUILD_LOG_MAX_BYTES,
  buildLogRowFrom,
  buildPhaseMessage,
  trimBuildOutput,
} from "./build-log"
import type { ConfinedSiteBuildResult } from "./confined-build"

const CONTEXT = {
  versionId: "ver_1",
  siteId: "site_1",
  operationId: "op_1",
  phase: "build" as const,
  argv: ["pnpm", "build"],
  now: 1_700_000_000_000,
}

function result(overrides: Partial<ConfinedSiteBuildResult> = {}): ConfinedSiteBuildResult {
  return {
    exitCode: 0,
    stdout: "built 42 modules",
    stderr: "",
    durationSeconds: 12.5,
    timedOut: false,
    outputTruncated: false,
    ...overrides,
  }
}

describe("trimBuildOutput", () => {
  it("passes short output through untouched", () => {
    expect(trimBuildOutput("all good")).toEqual({ value: "all good", truncated: false })
  })

  it("keeps the head and the tail of a long stream", () => {
    // The toolchain banner is at the top; the cause of a failure is at the
    // bottom. The middle of a long build is repetition.
    const long = `HEAD-MARKER${"x".repeat(SITE_BUILD_LOG_MAX_BYTES * 2)}TAIL-MARKER`
    const trimmed = trimBuildOutput(long)
    expect(trimmed.truncated).toBe(true)
    expect(trimmed.value.startsWith("HEAD-MARKER")).toBe(true)
    expect(trimmed.value.endsWith("TAIL-MARKER")).toBe(true)
    expect(trimmed.value).toContain("output trimmed by Cognia")
    expect(new TextEncoder().encode(trimmed.value).byteLength).toBeLessThan(
      SITE_BUILD_LOG_MAX_BYTES + 200
    )
  })

  it("does not throw when the cut lands mid-codepoint", () => {
    const long = "é".repeat(SITE_BUILD_LOG_MAX_BYTES)
    expect(() => trimBuildOutput(long)).not.toThrow()
  })
})

describe("buildLogRowFrom", () => {
  it("stores a successful phase too, which is what a broken one is compared against", () => {
    const row = buildLogRowFrom(result(), CONTEXT)
    expect(row).toMatchObject({
      id: "ver_1:build",
      versionId: "ver_1",
      phase: "build",
      exitCode: 0,
      argv: ["pnpm", "build"],
      truncated: false,
    })
    expect(row.stdout).toBe("built 42 modules")
    expect(row.storedBytes).toBeGreaterThan(0)
  })

  it("redacts credentials a build script printed itself", () => {
    // `confined-build.ts` blocks credential-shaped env KEYS from entering the
    // child; it cannot stop the child printing a token it fetched.
    const row = buildLogRowFrom(
      result({ stdout: "using CLOUDFLARE_API_TOKEN=abc123secret\nok" }),
      CONTEXT
    )
    expect(row.stdout).not.toContain("abc123secret")
    expect(row.stdout).toContain("[REDACTED]")
  })

  it("carries the upstream transport truncation through", () => {
    // `runConfinedSiteBuild` already caps each stream at `maxOutputBytes`; that
    // cut must still be reported even when the storage cap did nothing.
    const row = buildLogRowFrom(result({ outputTruncated: true }), CONTEXT)
    expect(row.truncated).toBe(true)
  })

  it("keeps a timeout distinguishable from a non-zero exit", () => {
    const row = buildLogRowFrom(result({ timedOut: true, exitCode: 0 }), CONTEXT)
    expect(row.timedOut).toBe(true)
  })

  it("uses a stable id per version and phase, so a retry rewrites its own row", () => {
    expect(buildLogRowFrom(result(), CONTEXT).id).toBe("ver_1:build")
    expect(buildLogRowFrom(result(), { ...CONTEXT, phase: "install" }).id).toBe("ver_1:install")
  })
})

describe("buildPhaseMessage", () => {
  it("names the command a phase is about to run", () => {
    expect(buildPhaseMessage("install", ["pnpm", "install"])).toBe("install: pnpm install")
  })

  it("falls back to the phase alone when there is no command", () => {
    expect(buildPhaseMessage("package", undefined)).toBe("package")
    expect(buildPhaseMessage("package", [])).toBe("package")
  })
})
