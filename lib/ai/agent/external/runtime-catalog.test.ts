import type {
  ExternalAgentBinaryDistribution,
  ExternalAgentJsDistribution,
  ExternalAgentRuntimeCatalogEntry,
} from "@/types/agent/external-agent-lifecycle"

import {
  EXTERNAL_AGENT_RUNTIMES,
  EXTERNAL_AGENT_RUNTIME_CATALOG_VERSION,
  UNPINNED_LAUNCH_WAIVERS,
  canonicalLaunchCommandString,
  catalogedPresetIds,
  deriveRuntimeBinding,
  findRuntimeById,
  findRuntimeForConfig,
  findRuntimeByPresetId,
  hasJsProviderChoice,
  hasUnpinnedLaunchWaiver,
  isDistributionInstallable,
  isUnpinnedLaunch,
  isWindowsExceptionEligible,
  normalizePlatform,
  offeredProviders,
  resolveSystemLaunch,
  runtimeSupportsPlatform,
  selectDistribution,
} from "./runtime-catalog"
import { EXTERNAL_AGENT_PRESETS, type ExternalAgentPresetId } from "./presets"
import { EXTERNAL_AGENT_BINARY_ALLOWLIST, baseCommandName } from "./security-policy"

const SHA = "a".repeat(64)

function jsDistribution(
  provider: ExternalAgentJsDistribution["provider"],
  overrides: Partial<ExternalAgentJsDistribution> = {}
): ExternalAgentJsDistribution {
  return {
    provider,
    packageName: "@example/agent",
    version: "1.2.3",
    entrypoint: "node_modules/.bin/example",
    lockAsset: { path: `runtime/example/${provider}.lock`, sha256: SHA },
    ...overrides,
  }
}

function entry(
  overrides: Partial<ExternalAgentRuntimeCatalogEntry> = {}
): ExternalAgentRuntimeCatalogEntry {
  return {
    runtimeId: "example",
    presetIds: ["example"],
    displayName: "Example",
    ownership: "managed",
    protocol: "acp",
    transport: "stdio",
    platforms: ["darwin", "linux"],
    distributions: [],
    sandbox: { required: true, windowsExceptionEligible: false },
    ...overrides,
  }
}

describe("catalog shape", () => {
  it("is versioned and non-empty", () => {
    expect(EXTERNAL_AGENT_RUNTIME_CATALOG_VERSION).toBeGreaterThanOrEqual(1)
    expect(EXTERNAL_AGENT_RUNTIMES.length).toBeGreaterThan(0)
  })

  it("has unique runtime ids", () => {
    const ids = EXTERNAL_AGENT_RUNTIMES.map((runtime) => runtime.runtimeId)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("never binds one preset to two runtimes", () => {
    const presets = catalogedPresetIds()
    expect(new Set(presets).size).toBe(presets.length)
  })

  it("covers every shipped preset, and invents none", () => {
    // The coverage invariant: a preset with no catalog entry is a runtime with
    // no version policy, no install story and no uninstall story -- exactly the
    // state every non-DSH preset was in before the catalog existed.
    const shipped = Object.keys(EXTERNAL_AGENT_PRESETS).filter(
      (id) => id !== "custom" && EXTERNAL_AGENT_PRESETS[id as ExternalAgentPresetId] !== null
    )
    expect([...catalogedPresetIds()].sort()).toEqual([...shipped].sort())
  })

  it("gives every non-remote runtime a way to report its version", () => {
    for (const runtime of EXTERNAL_AGENT_RUNTIMES) {
      if (runtime.ownership === "remote") continue
      expect(runtime.versionProbe).toBeDefined()
      expect(runtime.versionProbe?.timeoutMs).toBeGreaterThan(0)
    }
  })

  it("gives every system runtime a launch command and every remote runtime none", () => {
    for (const runtime of EXTERNAL_AGENT_RUNTIMES) {
      if (runtime.ownership === "system") {
        expect(runtime.systemCommand).toBeTruthy()
      }
      if (runtime.ownership === "remote") {
        expect(runtime.systemCommand).toBeUndefined()
      }
    }
  })

  it("keeps every catalogued launch inside the security policy's binary allowlist", () => {
    // The catalog may not widen what Cognia is willing to launch. `npx` is the
    // package runner itself and is governed by the npx package allowlist plus
    // the unpinned-launch waivers, not by the binary allowlist.
    for (const runtime of EXTERNAL_AGENT_RUNTIMES) {
      if (!runtime.systemCommand || isUnpinnedLaunch(runtime)) continue
      expect(EXTERNAL_AGENT_BINARY_ALLOWLIST).toContain(baseCommandName(runtime.systemCommand))
    }
  })

  it("accounts for every unpinned launch with a written reason", () => {
    for (const runtime of EXTERNAL_AGENT_RUNTIMES) {
      if (!isUnpinnedLaunch(runtime)) continue
      expect(hasUnpinnedLaunchWaiver(runtime.runtimeId)).toBe(true)
      expect(UNPINNED_LAUNCH_WAIVERS[runtime.runtimeId].length).toBeGreaterThan(20)
    }
  })

  it("waives no runtime that is already pinned", () => {
    // The waiver list may only shrink; a stale entry would hide a closed hole.
    for (const runtimeId of Object.keys(UNPINNED_LAUNCH_WAIVERS)) {
      const runtime = findRuntimeById(runtimeId)
      expect(runtime).toBeDefined()
      expect(isUnpinnedLaunch(runtime!)).toBe(true)
    }
  })

  it("marks no runtime Windows-eligible unless it supports Windows", () => {
    for (const runtime of EXTERNAL_AGENT_RUNTIMES) {
      if (!runtime.sandbox.windowsExceptionEligible) continue
      expect(runtime.platforms).toContain("win32")
    }
  })
})

describe("lookup", () => {
  it("finds by runtime id and by preset id", () => {
    const runtime = EXTERNAL_AGENT_RUNTIMES[0]
    expect(findRuntimeById(runtime.runtimeId)).toBe(runtime)
    expect(findRuntimeByPresetId(runtime.presetIds[0])).toBe(runtime)
  })

  it("returns undefined for unknown ids", () => {
    expect(findRuntimeById("nope")).toBeUndefined()
    expect(findRuntimeByPresetId("nope")).toBeUndefined()
  })
})

describe("platform support", () => {
  it("normalizes Tauri platform spellings", () => {
    expect(normalizePlatform("macos")).toBe("darwin")
    expect(normalizePlatform("windows")).toBe("win32")
    expect(normalizePlatform("linux")).toBe("linux")
  })

  it("accepts either spelling when checking support", () => {
    const runtime = entry({ platforms: ["darwin"] })
    expect(runtimeSupportsPlatform(runtime, "macos")).toBe(true)
    expect(runtimeSupportsPlatform(runtime, "darwin")).toBe(true)
    expect(runtimeSupportsPlatform(runtime, "win32")).toBe(false)
  })
})

describe("isDistributionInstallable", () => {
  it("requires an approved lock digest for package-manager distributions", () => {
    expect(isDistributionInstallable(jsDistribution("npm"))).toBe(true)
    expect(
      isDistributionInstallable(
        jsDistribution("npm", { lockAsset: { path: "x", sha256: "short" } })
      )
    ).toBe(false)
    expect(
      isDistributionInstallable(jsDistribution("npm", { lockAsset: { path: "", sha256: SHA } }))
    ).toBe(false)
  })

  it("requires https plus a checksum on every binary artifact", () => {
    const binary: ExternalAgentBinaryDistribution = {
      provider: "binary",
      version: "1.0.0",
      artifacts: [
        {
          platformKey: "darwin-arm64",
          url: "https://example.test/a.tar.gz",
          integrity: { sha256: SHA },
          archive: "tar.gz",
          entrypoint: "bin/a",
        },
      ],
    }
    expect(isDistributionInstallable(binary)).toBe(true)

    expect(
      isDistributionInstallable({
        ...binary,
        artifacts: [{ ...binary.artifacts[0], url: "http://example.test/a.tar.gz" }],
      })
    ).toBe(false)

    expect(
      isDistributionInstallable({
        ...binary,
        artifacts: [{ ...binary.artifacts[0], integrity: { sha256: "" } }],
      })
    ).toBe(false)

    expect(isDistributionInstallable({ ...binary, artifacts: [] })).toBe(false)
  })
})

describe("selectDistribution", () => {
  it("refuses when nothing is catalogued", () => {
    const result = selectDistribution(entry())
    expect(result.distribution).toBeUndefined()
    expect(result.blockingCode).toBe("runtime_missing")
    expect(result.detail).toContain("no managed distribution")
  })

  it("refuses an unlocked distribution instead of resolving at install time", () => {
    const result = selectDistribution(
      entry({ distributions: [jsDistribution("npm", { lockAsset: { path: "x", sha256: "" } })] })
    )
    expect(result.distribution).toBeUndefined()
    expect(result.blockingCode).toBe("runtime_missing")
    expect(result.detail).toContain("lacks an approved lock")
  })

  it("honours a per-runtime override over the global preference", () => {
    const runtime = entry({
      distributions: [jsDistribution("npm"), jsDistribution("pnpm"), jsDistribution("bun")],
    })
    const result = selectDistribution(runtime, { preferred: "npm", override: "bun" })
    expect(result.distribution?.provider).toBe("bun")
    expect(result.switchedFromRequested).toBe(false)
  })

  it("flags a fallback as a switch rather than switching silently", () => {
    const runtime = entry({ distributions: [jsDistribution("npm")] })
    const result = selectDistribution(runtime, { preferred: "pnpm" })
    expect(result.distribution?.provider).toBe("npm")
    expect(result.switchedFromRequested).toBe(true)
    expect(result.requested).toBe("pnpm")
  })

  it("does not flag a switch when the caller expressed no preference", () => {
    const runtime = entry({ distributions: [jsDistribution("npm")] })
    const result = selectDistribution(runtime)
    expect(result.distribution?.provider).toBe("npm")
    expect(result.switchedFromRequested).toBe(false)
  })

  it("skips providers whose tool is not on this host", () => {
    const runtime = entry({ distributions: [jsDistribution("bun"), jsDistribution("npm")] })
    const result = selectDistribution(runtime, { available: ["npm"] })
    expect(result.distribution?.provider).toBe("npm")
  })

  it("refuses when no provider tool is available at all", () => {
    const runtime = entry({ distributions: [jsDistribution("bun")] })
    const result = selectDistribution(runtime, { available: ["npm"] })
    expect(result.distribution).toBeUndefined()
    expect(result.detail).toContain("no provider tool")
  })
})

describe("launch resolution", () => {
  it("resolves a system launch and copies the argument list", () => {
    const runtime = entry({ systemCommand: "droid", launchArgs: ["exec"] })
    const launch = resolveSystemLaunch(runtime)
    expect(launch).toEqual({ command: "droid", args: ["exec"] })
    launch!.args.push("mutated")
    expect(runtime.launchArgs).toEqual(["exec"])
  })

  it("resolves nothing for a runtime with no launch command", () => {
    expect(resolveSystemLaunch(entry())).toBeUndefined()
  })

  it("detects every resolving package runner, suffix included", () => {
    expect(isUnpinnedLaunch(entry({ systemCommand: "npx" }))).toBe(true)
    expect(isUnpinnedLaunch(entry({ systemCommand: "npx.cmd" }))).toBe(true)
    expect(isUnpinnedLaunch(entry({ systemCommand: "uvx" }))).toBe(true)
    expect(isUnpinnedLaunch(entry({ systemCommand: "bunx" }))).toBe(true)
    expect(isUnpinnedLaunch(entry({ systemCommand: "codex" }))).toBe(false)
    expect(isUnpinnedLaunch(entry())).toBe(false)
  })

  it("canonicalizes argument lists unambiguously for the consent digest", () => {
    const joined = canonicalLaunchCommandString({ command: "agent", args: ["a b"] })
    const split = canonicalLaunchCommandString({ command: "agent", args: ["a", "b"] })
    expect(joined).not.toBe(split)
  })
})

describe("Windows exception eligibility", () => {
  const eligible = entry({
    platforms: ["darwin", "linux", "win32"],
    sandbox: { required: true, windowsExceptionEligible: true },
  })

  it("offers consent only on Windows", () => {
    expect(isWindowsExceptionEligible(eligible, "win32")).toBe(true)
    expect(isWindowsExceptionEligible(eligible, "windows")).toBe(true)
    // macOS and Linux must never route through the consent path.
    expect(isWindowsExceptionEligible(eligible, "darwin")).toBe(false)
    expect(isWindowsExceptionEligible(eligible, "linux")).toBe(false)
  })

  it("refuses when the catalog does not mark the runtime eligible", () => {
    expect(isWindowsExceptionEligible(entry({ platforms: ["win32"] }), "win32")).toBe(false)
  })

  it("refuses when the runtime does not support Windows at all", () => {
    const mismatched = entry({
      platforms: ["darwin"],
      sandbox: { required: true, windowsExceptionEligible: true },
    })
    expect(isWindowsExceptionEligible(mismatched, "win32")).toBe(false)
  })
})

describe("offered providers", () => {
  it("lists installable providers in catalog order without duplicates", () => {
    const runtime = entry({
      distributions: [
        jsDistribution("pnpm"),
        jsDistribution("pnpm", { version: "2.0.0" }),
        jsDistribution("npm"),
      ],
    })
    expect(offeredProviders(runtime)).toEqual(["pnpm", "npm"])
  })

  it("hides providers whose distribution is not installable", () => {
    const runtime = entry({
      distributions: [jsDistribution("npm", { lockAsset: { path: "x", sha256: "" } })],
    })
    expect(offeredProviders(runtime)).toEqual([])
    expect(hasJsProviderChoice(runtime)).toBe(false)
  })

  it("reports a real choice only when more than one JS provider is offered", () => {
    expect(hasJsProviderChoice(entry({ distributions: [jsDistribution("npm")] }))).toBe(false)
    expect(
      hasJsProviderChoice(entry({ distributions: [jsDistribution("npm"), jsDistribution("bun")] }))
    ).toBe(true)
  })
})

describe("binding a saved configuration to a runtime", () => {
  function saved(overrides: Record<string, unknown> = {}) {
    return {
      metadata: undefined,
      protocol: "acp",
      process: { command: "droid", args: ["exec", "--output-format", "acp-daemon"] },
      ...overrides,
    } as Parameters<typeof findRuntimeForConfig>[0]
  }

  it("uses the preset id when the config carries one", () => {
    const entry = findRuntimeForConfig(saved({ metadata: { preset: "codex" } }))
    expect(entry?.runtimeId).toBe("codex-acp")
  })

  it("falls back to the launch command for a hand-configured agent", () => {
    expect(findRuntimeForConfig(saved())?.runtimeId).toBe("droid")
  })

  it("requires the protocol to agree, not just the command", () => {
    // `codex` is the command for the app-server runtime; an ACP agent that
    // happens to name it is a different thing.
    expect(
      findRuntimeForConfig(saved({ protocol: "codex-app-server", process: { command: "codex" } }))
        ?.runtimeId
    ).toBe("codex-app-server")
    expect(
      findRuntimeForConfig(saved({ protocol: "acp", process: { command: "codex" } }))
    ).toBeUndefined()
  })

  it("disambiguates the npx runtimes by the package they run", () => {
    const cases: [string, string][] = [
      ["@zed-industries/codex-acp", "codex-acp"],
      ["@google/gemini-cli", "gemini-cli"],
      ["@qwen-code/qwen-code", "qwen-code"],
    ]
    for (const [pkg, runtimeId] of cases) {
      const entry = findRuntimeForConfig(
        saved({ protocol: "acp", process: { command: "npx", args: ["-y", pkg] } })
      )
      expect(entry?.runtimeId).toBe(runtimeId)
    }
  })

  it("refuses to guess when a package runner names no package", () => {
    // An incorrect binding would attribute an agent's sessions to the wrong
    // runtime and let an uninstall proceed while something was still using it.
    expect(
      findRuntimeForConfig(saved({ protocol: "acp", process: { command: "npx", args: ["-y"] } }))
    ).toBeUndefined()
  })

  it("refuses an unknown package behind a known runner", () => {
    expect(
      findRuntimeForConfig(
        saved({ protocol: "acp", process: { command: "npx", args: ["-y", "@evil/pkg"] } })
      )
    ).toBeUndefined()
  })

  it("returns nothing for a config with no process at all", () => {
    expect(findRuntimeForConfig(saved({ process: undefined }))).toBeUndefined()
  })

  it("returns nothing for a command no runtime launches", () => {
    expect(
      findRuntimeForConfig(saved({ process: { command: "definitely-not-an-agent" } }))
    ).toBeUndefined()
  })

  it("prefers the preset id over a conflicting command", () => {
    const entry = findRuntimeForConfig(
      saved({ metadata: { preset: "droid" }, process: { command: "codex" } })
    )
    expect(entry?.runtimeId).toBe("droid")
  })

  it("ignores a preset id the catalog does not know, and still matches by command", () => {
    const entry = findRuntimeForConfig(saved({ metadata: { preset: "made-up" } }))
    expect(entry?.runtimeId).toBe("droid")
  })

  it("derives the binding with the catalog's ownership", () => {
    expect(deriveRuntimeBinding(saved())).toEqual({ runtimeId: "droid", ownership: "system" })
    expect(
      deriveRuntimeBinding(saved({ metadata: { preset: "deepseek-harness-readonly" } }))
    ).toEqual({ runtimeId: "deepseek-harness", ownership: "managed" })
  })

  it("derives nothing when nothing matches", () => {
    expect(deriveRuntimeBinding(saved({ process: undefined }))).toBeUndefined()
  })
})
