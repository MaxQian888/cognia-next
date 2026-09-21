import { BUILTIN_ACTIONS, defaultExtension } from "../config/builtin-catalog"
import { compileFusionConfig } from "../config/compile"
import { builtinPolicy } from "../config/builtin-catalog"
import { fakeTierRegistry } from "../fake/mock-registry"
import type { ActionConfig } from "../contracts/schemas"
import {
  actionConfigHash,
  actionExtensionFor,
  draftActionFor,
  EDITABLE_ACTION_MODES,
  listFusionActions,
  sanitizeActionOverride,
  sanitizeCustomAction,
  validateActionDraft,
  validateOverride,
  withActionOverride,
  withCustomAction,
  withoutActionOverride,
  withoutCustomAction,
} from "./action-catalog"
import { normalizeRouterFusionSettings, type RouterFusionSettings } from "./settings"

function settings(patch: Partial<RouterFusionSettings> = {}): RouterFusionSettings {
  return normalizeRouterFusionSettings({ enabled: true, ...patch })
}

function custom(overrides: Partial<ActionConfig> = {}): ActionConfig {
  return { ...draftActionFor("panel", "panel_three"), ...overrides }
}

describe("validateActionDraft", () => {
  it("accepts a draft seeded from the built-in action of its mode", () => {
    for (const mode of EDITABLE_ACTION_MODES) {
      expect(validateActionDraft(draftActionFor(mode, `my_${mode}`), [])).toEqual([])
    }
  })

  it("refuses an id that is malformed or already taken", () => {
    expect(validateActionDraft(custom({ id: "X" }), [])).toContainEqual({
      field: "id",
      code: "ID_INVALID",
    })
    expect(validateActionDraft(custom({ id: "panel_review" }), [])).toContainEqual({
      field: "id",
      code: "ID_TAKEN",
    })
    expect(validateActionDraft(custom(), ["panel_three"])).toContainEqual({
      field: "id",
      code: "ID_TAKEN",
    })
  })

  it("offers delegate now that B4 runs it, and only with the code fixture profile", () => {
    expect(EDITABLE_ACTION_MODES).toContain("delegate")
    const draft = draftActionFor("delegate", "my_delegate")
    expect(draft).toMatchObject({
      mode: "delegate",
      verifier_profile: "code_fixture",
      roles: { lead: "powerful", worker: "fast" },
    })
    expect(validateActionDraft(draft, [])).toEqual([])
    expect(validateActionDraft({ ...draft, verifier_profile: "text_basic" }, [])).toContainEqual({
      field: "verifier_profile",
      code: "PROFILE_NOT_ALLOWED",
    })
  })

  it("names every role problem and a profile the mode does not offer", () => {
    const issues = validateActionDraft(
      custom({
        roles: { panel_a: "fast", judge: "", worker: "fast" },
        verifier_profile: "code_fixture",
      }),
      []
    )
    expect(issues).toEqual(
      expect.arrayContaining([
        { field: "roles", code: "ROLE_MISSING", role: "panel_b" },
        { field: "roles", code: "ROLE_MISSING", role: "synthesizer" },
        { field: "roles", code: "ALIAS_EMPTY", role: "judge" },
        { field: "roles", code: "ROLE_UNKNOWN", role: "worker" },
        { field: "verifier_profile", code: "PROFILE_NOT_ALLOWED" },
      ])
    )
  })
})

describe("validateOverride", () => {
  const panel = BUILTIN_ACTIONS.find((action) => action.id === "panel_review")!

  it("checks the roles an override would leave, the cap and the panel size", () => {
    expect(validateOverride(panel, { roles: { judge: " " } })).toContainEqual({
      field: "roles",
      code: "ALIAS_EMPTY",
      role: "judge",
    })
    expect(validateOverride(panel, { runCapUsd: "1.2345678" })).toContainEqual({
      field: "runCapUsd",
      code: "CAP_INVALID",
    })
    expect(validateOverride(panel, { limits: { panel_size: 3 } })).toContainEqual({
      field: "panel_size",
      code: "PANEL_C_REQUIRED",
    })
    expect(
      validateOverride(panel, { limits: { panel_size: 3 }, roles: { panel_c: "powerful" } })
    ).toEqual([])
    expect(validateOverride(panel, { limits: { panel_size: 4 } })).toContainEqual({
      field: "panel_size",
      code: "LIMIT_INVALID",
    })
  })

  it("lets a built-in keep its own profile even when the editor no longer offers it", () => {
    const cascadeCode = BUILTIN_ACTIONS.find((action) => action.id === "cascade_code")!
    expect(validateOverride(cascadeCode, { verifier_profile: "code_fixture" })).toEqual([])
    expect(validateOverride(cascadeCode, { verifier_profile: "evidence_review" })).toContainEqual({
      field: "verifier_profile",
      code: "PROFILE_NOT_ALLOWED",
    })
  })
})

describe("overrides", () => {
  it("keeps only what differs from the action, and drops an override with nothing left", () => {
    const base = settings()
    const edited = withActionOverride(base, "panel_review", {
      roles: { judge: "balanced", panel_a: "fast" },
      runCapUsd: "3",
      webToolsEnabled: false,
      limits: { panel_size: 2, panel_evidence_rounds: 0 },
    })
    expect(edited.panel_review).toEqual({
      roles: { judge: "balanced" },
      runCapUsd: "3",
      webToolsEnabled: false,
      limits: { panel_evidence_rounds: 0 },
    })
    const back = withActionOverride(settings({ actionOverrides: edited }), "panel_review", {
      roles: { judge: "powerful" },
      runCapUsd: base.runCapUsdByMode.panel,
      webToolsEnabled: true,
      limits: { panel_evidence_rounds: defaultExtension("panel").limits.panel_evidence_rounds },
    })
    expect(back.panel_review).toBeUndefined()
    expect(withoutActionOverride(settings({ actionOverrides: edited }), "panel_review")).toEqual({})
  })

  it("ignores an edit of an action that does not exist", () => {
    expect(withActionOverride(settings(), "ghost", { enabled: false })).toEqual({})
  })

  it("changes the action's hash with every edit and restores it when undone", () => {
    const base = settings()
    const hashOf = (s: RouterFusionSettings) => {
      const action = listFusionActions(s).find((a) => a.id === "cascade_schema")!
      return actionConfigHash(action, actionExtensionFor(action, s))
    }
    const original = hashOf(base)
    const withCap = settings({
      actionOverrides: withActionOverride(base, "cascade_schema", { runCapUsd: "0.5" }),
    })
    const withRole = settings({
      actionOverrides: withActionOverride(base, "cascade_schema", {
        roles: { strong: "balanced" },
      }),
    })
    expect(new Set([original, hashOf(withCap), hashOf(withRole)]).size).toBe(3)
    const undone = settings({
      actionOverrides: withActionOverride(withRole, "cascade_schema", {
        roles: { strong: "powerful" },
      }),
    })
    expect(hashOf(undone)).toBe(original)
  })

  it("applies the override and the mode cap to the extension a run pins", () => {
    const s = settings({
      runCapUsdByMode: { direct: "0.5", cascade: "1.25", panel: "2", delegate: "5" },
      actionOverrides: {
        panel_review: { runCapUsd: "3", webToolsEnabled: false, limits: { panel_size: 3 } },
      },
    })
    const [cascade, panel] = ["cascade_schema", "panel_review"].map((id) =>
      listFusionActions(s).find((a) => a.id === id)!
    )
    expect(actionExtensionFor(cascade, s).run_cap_microusd).toBe(1_250_000)
    expect(actionExtensionFor(panel, s)).toMatchObject({
      run_cap_microusd: 3_000_000,
      web_tools_enabled: false,
      limits: { panel_size: 3 },
    })
  })
})

describe("custom actions", () => {
  it("adds, replaces and removes an action of the user's own, with its override", () => {
    const added = withCustomAction(settings(), custom())
    expect(added.map((a) => a.id)).toEqual(["panel_three"])
    const replaced = withCustomAction(
      settings({ customActions: added }),
      custom({ enabled: false })
    )
    expect(replaced).toEqual([custom({ enabled: false })])
    const removed = withoutCustomAction(
      settings({ customActions: replaced, actionOverrides: { panel_three: { runCapUsd: "1" } } }),
      "panel_three"
    )
    expect(removed).toEqual({ customActions: [], actionOverrides: {} })
  })

  it("lists the built-ins first, then the user's own, each with its override", () => {
    const s = settings({
      customActions: [custom()],
      actionOverrides: { panel_three: { enabled: false }, direct_economy: { enabled: false } },
    })
    const listed = listFusionActions(s)
    expect(listed.map((a) => a.id)).toEqual([...BUILTIN_ACTIONS.map((a) => a.id), "panel_three"])
    expect(listed.find((a) => a.id === "panel_three")?.enabled).toBe(false)
    expect(listed.find((a) => a.id === "direct_economy")?.enabled).toBe(false)
  })

  it("compiles every action a valid catalog lists", () => {
    const s = settings({ customActions: [custom(), draftActionFor("direct", "quick_answer")] })
    const actions = listFusionActions(s)
    const compiled = compileFusionConfig({
      policy: builtinPolicy(actions),
      registry: fakeTierRegistry(),
      extensions: Object.fromEntries(actions.map((a) => [a.id, actionExtensionFor(a, s)])),
      environment: "test",
    })
    expect(Object.keys(compiled.actions)).toEqual(
      expect.arrayContaining(["panel_three", "quick_answer"])
    )
  })
})

describe("sanitizing what was persisted", () => {
  it("keeps only the well-formed parts of an override", () => {
    expect(
      sanitizeActionOverride({
        enabled: "yes",
        roles: { judge: "powerful", panel_a: 7, panel_b: "" },
        runCapUsd: "abc",
        webToolsEnabled: false,
        limits: { panel_size: 3, deadline_ms: -1, invented: 4 },
        extra: true,
      })
    ).toEqual({ roles: { judge: "powerful" }, webToolsEnabled: false, limits: { panel_size: 3 } })
    expect(sanitizeActionOverride({ enabled: "no" })).toBeNull()
    expect(sanitizeActionOverride([])).toBeNull()
  })

  it("keeps a custom action only when it would compile, and never a duplicate", () => {
    expect(sanitizeCustomAction(custom(), [])).toEqual(custom())
    expect(sanitizeCustomAction(custom(), ["panel_three"])).toBeNull()
    expect(sanitizeCustomAction({ ...custom(), roles: { panel_a: 1 } }, [])).toBeNull()
    expect(sanitizeCustomAction({ ...custom(), enabled: "true" }, [])).toBeNull()
    expect(sanitizeCustomAction(draftActionFor("delegate", "my_delegate"), [])).toEqual(
      draftActionFor("delegate", "my_delegate")
    )
    expect(
      sanitizeCustomAction(
        { ...draftActionFor("delegate", "my_delegate"), verifier_profile: "text_basic" },
        []
      )
    ).toBeNull()
    expect(sanitizeCustomAction("nope", [])).toBeNull()
  })

  it("normalizes persisted settings through the same rules", () => {
    const normalized = normalizeRouterFusionSettings({
      customActions: [custom(), custom(), { id: "bad" }, draftActionFor("direct", "panel_review")],
      actionOverrides: {
        panel_review: { webToolsEnabled: false, nonsense: 1 },
        empty: { enabled: "x" },
      },
    })
    expect(normalized.customActions).toEqual([custom()])
    expect(normalized.actionOverrides).toEqual({ panel_review: { webToolsEnabled: false } })
  })
})
