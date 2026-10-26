import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { validatePromptBody } from "@/lib/prompts/template"
import type { PromptDefinitionV1 } from "@/lib/prompts/types"
import * as teamPrompts from "./team-prompts"

const repoRoot = path.resolve(__dirname, "../../../..")

const defs = Object.values(teamPrompts).filter(
  (value): value is PromptDefinitionV1 =>
    typeof value === "object" && value !== null && "defaultBody" in value
)

describe("team prompt definitions (ADR-0236)", () => {
  it("exports every team runtime definition under the team group", () => {
    expect(defs.map((def) => def.id).sort()).toEqual(
      [
        "team.lead.planning",
        "team.lead.planning-system",
        "team.ledger.judge",
        "team.ledger.schema-hint",
        "team.replan.lead",
        "team.review.revision-request",
        "team.structured.json-instruction",
        "team.structured.retry-note",
        "team.teammate.task",
        "team.teammate.upstream-results",
        "team.ultracode.plan-hint",
        "team.ultracode.planner",
      ].sort()
    )
    for (const def of defs) expect(def.group).toBe("team")
  })

  it("ships defaults that satisfy their own contract", () => {
    for (const def of defs) {
      const issues =
        def.operation === "inspect-only" ? [] : validatePromptBody(def, def.defaultBody)
      expect({ id: def.id, issues }).toEqual({ id: def.id, issues: [] })
    }
  })

  it("keeps protocol text inspect-only and wording editable at account and project scope", () => {
    for (const def of defs) {
      if (def.kind === "protocol") {
        expect(def.operation).toBe("inspect-only")
        expect(def.scopes).toEqual([])
      } else {
        expect(def.scopes).toEqual(["account", "workspace"])
      }
    }
  })

  it("names consumers that resolve the definition", () => {
    for (const def of defs) {
      for (const consumer of def.consumers) {
        const file = path.join(repoRoot, consumer)
        expect({ consumer, exists: existsSync(file) }).toEqual({ consumer, exists: true })
        const source = readFileSync(file, "utf8")
        expect({ consumer, resolves: /\bresolve(Turn)?Prompt(Async)?\(/.test(source) }).toEqual({
          consumer,
          resolves: true,
        })
      }
    }
  })
})

describe("teamPromptContext", () => {
  it("scopes to the team's project when it has one", () => {
    expect(teamPrompts.teamPromptContext({ projectId: "ws-1" })).toEqual({ workspaceId: "ws-1" })
    expect(teamPrompts.teamPromptContext({})).toEqual({})
  })
})
