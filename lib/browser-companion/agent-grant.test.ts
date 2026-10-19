import { validateAgentCapabilityGrant } from "@cognia/agent-config-types/agent-capability-grant"

import {
  BROWSER_COMPANION_AGENT_INSTRUCTION,
  BROWSER_COMPANION_AGENT_PROMPT,
  browserCompanionGrant,
} from "./agent-grant"
import {
  __setPromptOverrideSnapshotForTests,
  buildPromptOverrideSnapshot,
} from "@/lib/prompts/snapshot"
import { __resetPromptVerdictsForTests } from "@/lib/prompts/resolve"
import { validatePromptBody } from "@/lib/prompts/template"

describe("browserCompanionGrant", () => {
  it("is a valid grant that only adds instructions", () => {
    const grant = browserCompanionGrant("browser-a")
    expect(grant).toEqual({
      schemaVersion: 1,
      source: { kind: "browser-companion", id: "browser-a" },
      instructions: [BROWSER_COMPANION_AGENT_INSTRUCTION],
    })
    // No tool, skill, MCP or permission change: those would widen or narrow
    // the run beyond "act in the browser the user started from".
    expect(grant).not.toHaveProperty("tools")
    expect(grant).not.toHaveProperty("permissionMode")
    expect(validateAgentCapabilityGrant(grant)).toMatchObject({ ok: true })
  })

  it("tells the model how the user stays in charge", () => {
    for (const phrase of [
      "browser_site_permission_required",
      "browser_user_takeover",
      "password",
    ]) {
      expect(BROWSER_COMPANION_AGENT_INSTRUCTION).toContain(phrase)
    }
  })
})

describe("the grant instruction as a Prompt Center entry (ADR-0236)", () => {
  afterEach(() => {
    __setPromptOverrideSnapshotForTests(null)
    __resetPromptVerdictsForTests()
  })

  it("cannot be published without the two answers the user's control depends on", () => {
    expect(
      validatePromptBody(BROWSER_COMPANION_AGENT_PROMPT, "Act freely in the browser.")
    ).toEqual(
      expect.arrayContaining([
        { code: "missing-fragment", fragment: "browser_site_permission_required" },
        { code: "missing-fragment", fragment: "browser_user_takeover" },
      ])
    )
  })

  it("carries a published override as the grant's only instruction", () => {
    const body =
      "You act in the user's browser. On browser_site_permission_required ask the user; " +
      "on browser_user_takeover stop."
    __setPromptOverrideSnapshotForTests(
      buildPromptOverrideSnapshot("test-db", [
        {
          bindingId: "pob",
          promptId: BROWSER_COMPANION_AGENT_PROMPT.id,
          scope: "account",
          targetId: "",
          revisionId: "por-browser-grant",
          body,
          contractVersion: BROWSER_COMPANION_AGENT_PROMPT.contractVersion,
        },
      ])
    )
    const grant = browserCompanionGrant("browser-a")
    expect(grant.instructions).toEqual([body])
    // The override changes wording only; the grant still adds nothing else.
    expect(Object.keys(grant).sort()).toEqual(["instructions", "schemaVersion", "source"])
  })
})
