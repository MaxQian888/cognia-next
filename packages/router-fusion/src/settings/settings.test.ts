import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { BUILTIN_ACTIONS } from "../config/builtin-catalog"
import { DEFAULT_RULE_ROW_ACTIONS, RULE_ROWS } from "../routing/action-router"
import {
  DEFAULT_ROUTER_FUSION_SETTINGS,
  ROUTER_FUSION_SURFACES,
  WIRED_RULE_ROWS,
  effectiveSurface,
  normalizeRouterFusionSettings,
  resolveDataClass,
} from "./settings"

describe("router-fusion settings", () => {
  it("[ACC:OFF-01] is off everywhere by default", () => {
    const settings = normalizeRouterFusionSettings(undefined)
    expect(settings.enabled).toBe(false)
    for (const surface of ROUTER_FUSION_SURFACES) {
      expect(settings.surfaces[surface]).toBe(false)
      expect(effectiveSurface(settings, surface)).toBe(false)
    }
    expect(settings.budgetMode).toBe("tracked")
    expect(settings).toEqual(DEFAULT_ROUTER_FUSION_SETTINGS)
    expect(settings).not.toBe(DEFAULT_ROUTER_FUSION_SETTINGS)
  })

  it("needs both the master and the surface switch", () => {
    const masterOnly = normalizeRouterFusionSettings({ enabled: true })
    expect(effectiveSurface(masterOnly, "chat")).toBe(false)
    const surfaceOnly = normalizeRouterFusionSettings({ enabled: false, surfaces: { chat: true } })
    expect(effectiveSurface(surfaceOnly, "chat")).toBe(false)
    const both = normalizeRouterFusionSettings({ enabled: true, surfaces: { chat: true } })
    expect(effectiveSurface(both, "chat")).toBe(true)
    expect(effectiveSurface(both, "gatewayRuns")).toBe(false)
    expect(effectiveSurface(undefined, "chat")).toBe(false)
  })

  it("[ACC:OFF-01] treats anything but a literal true as off", () => {
    expect(effectiveSurface({ enabled: "true", surfaces: { chat: true } }, "chat")).toBe(false)
    expect(effectiveSurface({ enabled: 1, surfaces: { chat: true } }, "chat")).toBe(false)
    expect(effectiveSurface({ enabled: true, surfaces: { chat: 1 } }, "chat")).toBe(false)
    expect(effectiveSurface({ enabled: true, surfaces: null }, "chat")).toBe(false)
    expect(effectiveSurface({ enabled: true }, "chat")).toBe(false)
    expect(effectiveSurface(null, "chat")).toBe(false)
  })

  it("acts only on rule rows that can propose a running mode; B4 leaves none dormant", () => {
    const modeOf = new Map(BUILTIN_ACTIONS.map((action) => [action.id, action.mode]))
    for (const row of RULE_ROWS) {
      const modes = DEFAULT_RULE_ROW_ACTIONS[row].map((id) => modeOf.get(id))
      expect(modes.every((mode) => mode !== undefined)).toBe(true)
      const runs = modes.some(
        (mode) => mode === "direct" || mode === "cascade" || mode === "panel" || mode === "delegate"
      )
      expect(WIRED_RULE_ROWS.includes(row)).toBe(runs)
    }
    expect(WIRED_RULE_ROWS).toEqual([
      "economy_simple",
      "cascade_verifiable",
      "panel_research",
      "delegate_multifile",
    ])
    expect(RULE_ROWS.filter((row) => !WIRED_RULE_ROWS.includes(row))).toEqual([])
  })

  it("keeps the switch leaf free of imports", () => {
    const source = readFileSync(join(__dirname, "switches.ts"), "utf8")
    expect(source).not.toMatch(/^\s*import\s/m)
    expect(source).not.toMatch(/\brequire\(|\bimport\(/)
  })

  it("drops unknown rule rows, malformed money and out-of-range numbers", () => {
    const settings = normalizeRouterFusionSettings({
      enabled: "yes",
      approvedRuleRows: ["panel_research", "made_up", "panel_research"],
      ruleRowProvenance: { panel_research: "migrated_legacy_auto", made_up: "user" },
      runCapUsdByMode: { direct: "1.25", panel: "-3", cascade: 7 },
      unknownPriceCallReserveUsd: "0.1234567",
      breakerThreshold: 0,
      defaultDataClass: "secret",
      dataClassByWorkspaceId: { w1: "restricted", w2: "top" },
      restrictedGrantProviderIds: ["anthropic", "", 5, "anthropic"],
      llmClassifier: { enabled: true, timeoutMs: 999_999, cacheTtlSeconds: 30, routerModelId: "m" },
      budgetMode: "loose",
    })
    expect(settings.enabled).toBe(false)
    expect(settings.approvedRuleRows).toEqual(["panel_research"])
    expect(settings.ruleRowProvenance).toEqual({ panel_research: "migrated_legacy_auto" })
    expect(settings.runCapUsdByMode).toEqual({
      direct: "1.25",
      cascade: "1.00",
      panel: "2.00",
      delegate: "5.00",
    })
    expect(settings.unknownPriceCallReserveUsd).toBe("0.05")
    expect(settings.breakerThreshold).toBe(3)
    expect(settings.defaultDataClass).toBe("internal")
    expect(settings.dataClassByWorkspaceId).toEqual({ w1: "restricted" })
    expect(settings.restrictedGrantProviderIds).toEqual(["anthropic"])
    // Half a router model cannot be called: it is dropped, not kept.
    expect(settings.llmClassifier).toEqual({
      enabled: true,
      timeoutMs: 1500,
      cacheTtlSeconds: 30,
    })
    expect(settings.budgetMode).toBe("tracked")
  })

  it("round-trips a fully-populated settings object, copying what the editor may mutate", () => {
    const actionOverrides = { direct_baseline: { runCapUsd: "0.1", roles: { solver: "fast" } } }
    const customActions = [
      {
        id: "mine_direct",
        mode: "direct",
        roles: { solver: "balanced" },
        prompt_version: "roles-1",
        verifier_profile: "text_basic",
        enabled: true,
      },
    ]
    const settings = normalizeRouterFusionSettings({
      enabled: true,
      surfaces: { chat: true },
      budgetMode: "strict",
      approvedRuleRows: ["panel_research"],
      ruleRowProvenance: { panel_research: "user" },
      runCapUsdByMode: { direct: "0.25", cascade: "0.50", panel: "1.00", delegate: "2.00" },
      actionOverrides,
      customActions,
      unknownPriceCallReserveUsd: "0.02",
      defaultDataClass: "public",
      dataClassByWorkspaceId: { w1: "restricted" },
      restrictedGrantProviderIds: ["anthropic"],
      breakerThreshold: 7,
      llmClassifier: {
        enabled: true,
        routerProviderId: "openai",
        routerModelId: "gpt-5-mini",
        timeoutMs: 2_000,
        cacheTtlSeconds: 600,
      },
    })
    expect(settings).toMatchObject({
      enabled: true,
      budgetMode: "strict",
      ruleRowProvenance: { panel_research: "user" },
      runCapUsdByMode: { direct: "0.25", cascade: "0.50", panel: "1.00", delegate: "2.00" },
      unknownPriceCallReserveUsd: "0.02",
      defaultDataClass: "public",
      dataClassByWorkspaceId: { w1: "restricted" },
      breakerThreshold: 7,
      llmClassifier: {
        enabled: true,
        routerProviderId: "openai",
        routerModelId: "gpt-5-mini",
        timeoutMs: 2_000,
        cacheTtlSeconds: 600,
      },
    })
    // Copied, not aliased: the catalog editor must not mutate stored settings.
    expect(settings.actionOverrides).toEqual(actionOverrides)
    expect(settings.actionOverrides).not.toBe(actionOverrides)
    expect(settings.customActions).toEqual(customActions)
    expect(settings.customActions).not.toBe(customActions)
  })

  it("keeps only well-formed breaker trips on known surfaces", () => {
    const settings = normalizeRouterFusionSettings({
      trippedSurfaces: {
        chat: { trippedAt: 10, reason: "db_unavailable" },
        gatewayRuns: { trippedAt: "10", reason: "x" },
        utilityLedger: { trippedAt: 5, reason: "" },
        madeUp: { trippedAt: 1, reason: "y" },
      },
    })
    expect(settings.trippedSurfaces).toEqual({ chat: { trippedAt: 10, reason: "db_unavailable" } })
    expect(normalizeRouterFusionSettings({ trippedSurfaces: 3 }).trippedSurfaces).toEqual({})
  })

  it("keeps a captured legacy Auto snapshot for restore", () => {
    const snapshot = { capturedAt: 1, autoRouting: { enabled: true, candidateAliases: ["fast"] } }
    expect(
      normalizeRouterFusionSettings({ legacyAutoSnapshot: snapshot }).legacyAutoSnapshot
    ).toEqual(snapshot)
  })

  it("[ACC:AUTH-04] only ever raises the data class", () => {
    const settings = normalizeRouterFusionSettings({
      dataClassByWorkspaceId: { secret: "restricted", open: "public" },
    })
    expect(resolveDataClass(settings, undefined)).toBe("internal")
    expect(resolveDataClass(settings, "secret")).toBe("restricted")
    expect(resolveDataClass(settings, "open")).toBe("internal")
    expect(resolveDataClass(settings, "open", "public")).toBe("internal")
    expect(resolveDataClass(settings, "secret", "public")).toBe("restricted")
    expect(resolveDataClass(settings, undefined, "restricted")).toBe("restricted")
  })

  it("normalizes the LLM classifier: a whole router model, a TTL that may be 0, the judge migration record", () => {
    expect(DEFAULT_ROUTER_FUSION_SETTINGS.llmClassifier).toEqual({
      enabled: false,
      timeoutMs: 1500,
      cacheTtlSeconds: 600,
    })
    const settings = normalizeRouterFusionSettings({
      llmClassifier: {
        enabled: true,
        routerProviderId: "openai",
        routerModelId: "gpt-5-mini",
        timeoutMs: 0,
        cacheTtlSeconds: 0,
        judgeMigration: {
          capturedAt: 7,
          judge: { judge: { enabled: true, timeoutMs: 400 } },
          carried: ["routerModel", "made_up", "cacheTtlSeconds", "routerModel"],
        },
      },
    })
    expect(settings.llmClassifier).toEqual({
      enabled: true,
      routerProviderId: "openai",
      routerModelId: "gpt-5-mini",
      // A zero timeout would fail every call: back to the default.
      timeoutMs: 1500,
      // A zero TTL is "no cache", a real choice (a judge migrated with its cache off).
      cacheTtlSeconds: 0,
      judgeMigration: {
        capturedAt: 7,
        judge: { judge: { enabled: true, timeoutMs: 400 } },
        carried: ["routerModel", "cacheTtlSeconds"],
      },
    })
    expect(
      normalizeRouterFusionSettings({
        llmClassifier: {
          routerProviderId: " ",
          routerModelId: "m",
          cacheTtlSeconds: -1,
          judgeMigration: { capturedAt: "7" },
        },
      }).llmClassifier
    ).toEqual({ enabled: false, timeoutMs: 1500, cacheTtlSeconds: 600 })
  })

  it("wires the LLM classifier: its readers are the classifier, its settings and the judge it absorbs", () => {
    // B5 brought it out of dormancy (Rule 7). The type documents the wiring, the
    // settings section shows it, and this pins exactly who reads it, so a new
    // reader is a decision someone made, not an accident.
    let hits = ""
    try {
      hits = execFileSync(
        "git",
        [
          "grep",
          "--untracked",
          "-n",
          "llmClassifier",
          "--",
          "lib",
          "hooks",
          "components",
          "stores",
          "app",
          "sidecar",
          "cli",
          "packages",
        ],
        { cwd: join(__dirname, "..", "..", "..", ".."), encoding: "utf8" }
      )
    } catch (error) {
      if ((error as { status?: number }).status !== 1) throw error
    }
    const readers = [
      ...new Set(
        hits
          .split("\n")
          .filter((line) => line && !/\.test\.tsx?:/.test(line))
          .map((line) => line.slice(0, line.indexOf(":")))
      ),
    ].sort()
    expect(readers).toEqual([
      "components/settings/provider/routing/router-fusion-classifier-section.tsx",
      "lib/ai/routing/difficulty-judge.ts",
      "lib/router-fusion/routing/llm-classifier.ts",
      "lib/router-fusion/settings/classifier-migration.ts",
      "packages/router-fusion/src/settings/settings.ts",
    ])
    // …and the two Auto entry points consult what the classifier module builds.
    const root = join(__dirname, "..", "..", "..", "..")
    const read = (rel: string) => readFileSync(join(root, rel), "utf8")
    expect(read("lib/router-fusion/chat/chat-route-host.ts")).toMatch(/createRouteClassifier\(/)
    expect(read("lib/router-fusion/chat/route-chat-turn.ts")).toMatch(/host\.classify\(/)
    expect(read("lib/router-fusion/routing/run-route.ts")).toMatch(/host\.classify\(/)
    expect(read("components/settings/provider/routing/router-fusion-section.tsx")).toMatch(
      /<RouterFusionClassifierSection /
    )
  })
})
