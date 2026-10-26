import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { getPromptDefinition, listPromptDefinitions } from "./catalog"
import { validatePromptBody } from "./template"

const repoRoot = path.resolve(__dirname, "../..")

describe("prompt catalog", () => {
  const defs = listPromptDefinitions()

  it("registers the mounted AI Shell planning and error advisor consumers", () => {
    expect(getPromptDefinition("developer.ai-shell.plan")).toMatchObject({
      consumers: ["lib/terminal/ai-shell/plan-generator.ts"],
      activation: "next-operation",
      risk: "protocol",
    })
    expect(getPromptDefinition("developer.ai-shell.error-advisor")).toMatchObject({
      consumers: ["lib/terminal/ai-shell/error-advisor.ts"],
      activation: "next-operation",
      risk: "protocol",
    })
  })

  it("has unique namespaced ids that resolve back to their definition", () => {
    const ids = defs.map((def) => def.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const def of defs) {
      expect(def.id).toMatch(/^[a-z][a-z0-9-]*(\.[A-Za-z0-9-]+)+$/)
      expect(getPromptDefinition(def.id)).toBe(def)
    }
  })

  it("ships defaults that satisfy their own contract", () => {
    for (const def of defs) {
      const issues =
        def.operation === "inspect-only" ? [] : validatePromptBody(def, def.defaultBody)
      expect({ id: def.id, issues }).toEqual({ id: def.id, issues: [] })
    }
  })

  // Acceptance A16: an entry nothing resolves would be an editor control with
  // no effect. Every declared consumer must exist and resolve through the
  // resolver; reading `.defaultBody` would silently ignore every override.
  it("names consumers that exist and actually resolve the definition", () => {
    for (const def of defs) {
      expect(def.consumers.length).toBeGreaterThan(0)
      for (const consumer of def.consumers) {
        const file = path.join(repoRoot, consumer)
        expect({ id: def.id, consumer, exists: existsSync(file) }).toEqual({
          id: def.id,
          consumer,
          exists: true,
        })
        const source = readFileSync(file, "utf8")
        const resolves =
          def.operation === "inspect-only" || /\bresolve(Turn)?Prompt(Async)?\(/.test(source)
        expect({ id: def.id, consumer, resolves }).toEqual({ id: def.id, consumer, resolves: true })
      }
    }
  })

  it("gives every editable entry at least one scope and inspect-only entries none", () => {
    for (const def of defs) {
      if (def.operation === "inspect-only") expect(def.scopes).toEqual([])
      else expect(def.scopes.length).toBeGreaterThan(0)
    }
  })
})
