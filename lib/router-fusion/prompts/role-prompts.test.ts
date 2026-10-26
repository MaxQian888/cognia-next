import {
  BUILTIN_ROLE_PROFILE,
  customRolePromptVersion,
  draftActionFor,
  fakeTierRegistry,
  ROLE_PROMPTS,
  rolePromptProfileFor,
  systemPromptFor,
  type ActionConfig,
} from "@cognia/router-fusion"
import {
  normalizeRouterFusionSettings,
  type RouterFusionSettings,
} from "@cognia/router-fusion/settings/settings"

import { __resetPromptVerdictsForTests } from "@/lib/prompts/resolve"
import {
  __setPromptOverrideSnapshotForTests,
  buildPromptOverrideSnapshot,
} from "@/lib/prompts/snapshot"
import { validatePromptBody } from "@/lib/prompts/template"

import { buildFusionConfig } from "../chat/fusion-config"
import {
  EDITABLE_ROLE_NAMES,
  resolveCustomRolePrompts,
  resolveCustomRolePromptsAsync,
  ROUTER_FUSION_ROLE_PROMPTS,
  runRolePromptsFor,
  usesCustomRolePrompts,
} from "./role-prompts"

afterEach(() => {
  __setPromptOverrideSnapshotForTests(null)
  __resetPromptVerdictsForTests()
})

const JUDGE = ROUTER_FUSION_ROLE_PROMPTS.judge

/** A judge body that keeps every fragment the JudgeReport parser needs. */
function judgeBody(tag: string): string {
  return `# Judge (${tag})\nOutput a JudgeReport: supported_claim_ids, verification_requests, ready_to_synthesize.\n`
}

function publishJudge(body: string, revisionId: string): void {
  __setPromptOverrideSnapshotForTests(
    buildPromptOverrideSnapshot("test-db", [
      {
        bindingId: "pob-judge",
        promptId: JUDGE.id,
        scope: "account",
        targetId: "",
        revisionId,
        body,
        contractVersion: JUDGE.contractVersion,
      },
    ])
  )
}

function customPanel(promptVersion: string): ActionConfig {
  return { ...draftActionFor("panel", "my_panel"), prompt_version: promptVersion }
}

function settingsWith(actions: ActionConfig[]): RouterFusionSettings {
  return normalizeRouterFusionSettings({ enabled: true, customActions: actions })
}

function compile(settings: RouterFusionSettings) {
  return buildFusionConfig(settings, fakeTierRegistry(), "test").config
}

describe("Router + Fusion role prompt definitions", () => {
  it("registers one entry per workflow role, never the classifier", () => {
    expect(EDITABLE_ROLE_NAMES).toEqual([
      "common",
      "panel_member",
      "judge",
      "synthesizer",
      "lead",
      "worker",
      "reviewer",
      "compactor",
    ])
    expect(Object.values(ROUTER_FUSION_ROLE_PROMPTS).map((def) => def.id)).toEqual([
      "routing.fusion.role.common",
      "routing.fusion.role.panel-member",
      "routing.fusion.role.judge",
      "routing.fusion.role.synthesizer",
      "routing.fusion.role.lead",
      "routing.fusion.role.worker",
      "routing.fusion.role.reviewer",
      "routing.fusion.role.compactor",
    ])
  })

  it("ships the package's roles-1 text as each default, valid against its own contract", () => {
    for (const role of EDITABLE_ROLE_NAMES) {
      const def = ROUTER_FUSION_ROLE_PROMPTS[role]
      expect(def.defaultBody).toBe(ROLE_PROMPTS[role])
      expect(def).toMatchObject({
        kind: "role",
        group: "routing",
        operation: "replace-template",
        scopes: ["account"],
        risk: "protocol",
      })
      expect({ role, issues: validatePromptBody(def, def.defaultBody) }).toEqual({
        role,
        issues: [],
      })
      expect(def.maxChars).toBeGreaterThanOrEqual(def.defaultBody.length * 2)
    }
  })

  it("refuses an edit that drops the schema name a role's output is parsed against", () => {
    expect(validatePromptBody(JUDGE, "# Judge\nJust review the candidates.")).toContainEqual({
      code: "missing-fragment",
      fragment: "JudgeReport",
    })
  })
})

describe("resolving the user's role texts", () => {
  it("is the shipped text, byte for byte, until the user publishes an edit", async () => {
    __setPromptOverrideSnapshotForTests(buildPromptOverrideSnapshot("test-db", []))
    const profile = resolveCustomRolePrompts()
    expect(profile.prompts).toEqual(ROLE_PROMPTS)
    expect(profile.version).toBe(customRolePromptVersion(ROLE_PROMPTS))
    await expect(resolveCustomRolePromptsAsync()).resolves.toEqual(profile)
  })

  it("materializes a new version for every published edit", () => {
    publishJudge(judgeBody("one"), "por-rf-judge-one")
    const one = resolveCustomRolePrompts()
    expect(one.prompts.judge).toBe(judgeBody("one"))
    expect(one.prompts.classifier).toBe(ROLE_PROMPTS.classifier)
    expect(one.version).toMatch(/^roles-1-custom@[0-9a-f]{16}$/)

    publishJudge(judgeBody("two"), "por-rf-judge-two")
    const two = resolveCustomRolePrompts()
    expect(two.prompts.judge).toBe(judgeBody("two"))
    expect(two.version).not.toBe(one.version)
  })

  it("resolves nothing for a catalog where no action selects the custom text", async () => {
    expect(usesCustomRolePrompts(settingsWith([]))).toBe(false)
    expect(usesCustomRolePrompts(settingsWith([customPanel("roles-1")]))).toBe(false)
    await expect(runRolePromptsFor(settingsWith([customPanel("roles-1")]))).resolves.toBeUndefined()

    publishJudge(judgeBody("async"), "por-rf-judge-async")
    const custom = settingsWith([customPanel("roles-1-custom")])
    expect(usesCustomRolePrompts(custom)).toBe(true)
    await expect(runRolePromptsFor(custom)).resolves.toMatchObject({
      prompts: { judge: judgeBody("async") },
    })
  })
})

describe("a run's role text (A13)", () => {
  it("changes the system prompt only for an action on the custom version", () => {
    publishJudge(judgeBody("published"), "por-rf-run-published")
    const config = compile(settingsWith([customPanel("roles-1-custom")]))

    const mine = config.actions.my_panel
    const mineProfile = rolePromptProfileFor(config, mine)
    expect(mine.config.prompt_version).toBe(mineProfile.version)
    expect(systemPromptFor("judge", mineProfile)).toBe(
      `${ROLE_PROMPTS.common}\n${judgeBody("published")}`
    )

    // The built-in panel runs roles-1 whatever was published.
    const builtin = config.actions.panel_review
    expect(builtin.config.prompt_version).toBe("roles-1")
    expect(rolePromptProfileFor(config, builtin)).toBe(BUILTIN_ROLE_PROFILE)
    expect(systemPromptFor("judge", rolePromptProfileFor(config, builtin))).toBe(
      `${ROLE_PROMPTS.common}\n${ROLE_PROMPTS.judge}`
    )
  })

  it("gives the custom action a new identity when the override changes, and the built-in none", () => {
    const custom = settingsWith([customPanel("roles-1-custom")])
    publishJudge(judgeBody("first"), "por-rf-identity-first")
    const first = compile(custom)
    publishJudge(judgeBody("second"), "por-rf-identity-second")
    const second = compile(custom)

    expect(second.actions.my_panel.config.prompt_version).not.toBe(
      first.actions.my_panel.config.prompt_version
    )
    expect(second.actions.my_panel.actionHash).not.toBe(first.actions.my_panel.actionHash)
    expect(second.digest).not.toBe(first.digest)
    expect(second.actions.panel_review.actionHash).toBe(first.actions.panel_review.actionHash)
  })

  it("leaves a catalog without a custom-version action exactly as roles-1 compiles it", () => {
    const plain = compile(settingsWith([customPanel("roles-1")]))
    publishJudge(judgeBody("ignored"), "por-rf-ignored")
    const after = compile(settingsWith([customPanel("roles-1")]))
    expect(after.digest).toBe(plain.digest)
    expect(after.rolePrompts).toBeUndefined()
    expect(rolePromptProfileFor(after, after.actions.my_panel)).toBe(BUILTIN_ROLE_PROFILE)
  })

  it("pins the profile resolved at run start rather than re-reading the Prompt Center", () => {
    publishJudge(judgeBody("at start"), "por-rf-pinned-start")
    const rolePrompts = resolveCustomRolePrompts()
    publishJudge(judgeBody("later"), "por-rf-pinned-later")
    const { config } = buildFusionConfig(
      settingsWith([customPanel("roles-1-custom")]),
      fakeTierRegistry(),
      "test",
      { rolePrompts }
    )
    expect(config.rolePrompts).toEqual(rolePrompts)
    expect(rolePromptProfileFor(config, config.actions.my_panel).prompts.judge).toBe(
      judgeBody("at start")
    )
  })
})
