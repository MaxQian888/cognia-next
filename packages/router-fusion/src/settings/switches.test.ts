import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import {
  effectiveSurface,
  isRouterFusionSurfaceWired,
  ROUTER_FUSION_SURFACES,
  WIRED_ROUTER_FUSION_SURFACES,
} from "./switches"

const REPO_ROOT = join(__dirname, "..", "..", "..", "..")

describe("Router + Fusion switches", () => {
  it("[ACC:OFF-01] is off unless the master and the surface are literally true", () => {
    expect(effectiveSurface(undefined, "chat")).toBe(false)
    expect(effectiveSurface({ enabled: true }, "chat")).toBe(false)
    expect(effectiveSurface({ enabled: "true", surfaces: { chat: true } }, "chat")).toBe(false)
    expect(effectiveSurface({ enabled: true, surfaces: { chat: 1 } }, "chat")).toBe(false)
    expect(effectiveSurface({ enabled: true, surfaces: { chat: true } }, "chat")).toBe(true)
  })

  it("wires chat, both gateway lanes, utilities, agents/workflows and the companion", () => {
    const wired = [
      "chat",
      "gatewayRuns",
      "gatewayPassthroughLedger",
      "utilityLedger",
      "agentsWorkflows",
      // WP-C: web and mobile companions reach runs over the companion RPC.
      "companion",
    ]
    expect(WIRED_ROUTER_FUSION_SURFACES).toEqual(wired)
    // The order is the declaration order of ROUTER_FUSION_SURFACES, not of the list above.
    expect(ROUTER_FUSION_SURFACES.filter(isRouterFusionSurfaceWired).sort()).toEqual(
      [...wired].sort()
    )
    // Every declared surface is wired in this build; a surface declared ahead of
    // its call sites has to show up here as dormant again.
    expect(ROUTER_FUSION_SURFACES.filter((s) => !isRouterFusionSurfaceWired(s))).toEqual([])
  })

  it("has the companion surface asked by the companion bridge, the one call site that wires it", () => {
    const source = readFileSync(
      join(REPO_ROOT, "lib", "router-fusion", "gate", "companion-bridge.ts"),
      "utf8"
    )
    expect(source).toMatch(/routerFusionGate\([^)]*"companion"\)/)
  })

  it("has no call site asking the gate about a dormant surface", () => {
    // A dormant switch must stay inert: if a call site starts reading one, it
    // has to be wired (and listed above) in the same change.
    const dormant = ROUTER_FUSION_SURFACES.filter((surface) => !isRouterFusionSurfaceWired(surface))
    // Nothing is dormant in this build, so there is nothing to search for; an
    // empty alternation would match every `""` instead.
    if (dormant.length === 0) return
    // Two ways a call site can name a surface: asking the gate directly, or
    // handing one to a seam that asks for it (`{ surface: "gatewayRuns" }`).
    const pattern = `(routerFusionGate\\([^)]*|surface: )"(${dormant.join("|")})"`
    let hits = ""
    try {
      hits = execFileSync(
        "git",
        [
          "grep",
          "--untracked",
          "-nE",
          pattern,
          "--",
          "lib",
          "hooks",
          "components",
          "stores",
          "app",
          "sidecar",
          "cli",
        ],
        { cwd: REPO_ROOT, encoding: "utf8" }
      )
    } catch (error) {
      // `git grep` exits 1 when nothing matches.
      if ((error as { status?: number }).status !== 1) throw error
    }
    expect(hits.split("\n").filter((line) => line && !/\.test\.tsx?:/.test(line))).toEqual([])
  })

  it("stays a zero-import leaf the shared send path can load on the off path", () => {
    const source = readFileSync(join(__dirname, "switches.ts"), "utf8")
    expect(source).not.toMatch(/^\s*import\s/m)
  })
})
