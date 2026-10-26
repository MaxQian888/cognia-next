import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { validatePromptBody } from "@/lib/prompts/template"
import {
  __setPromptOverrideSnapshotForTests,
  buildPromptOverrideSnapshot,
} from "@/lib/prompts/snapshot"
import { freezePatternPromptScope, PATTERN_PROMPTS, VERIFY_LENS_PROMPTS } from "./pattern-prompts"

const repoRoot = path.resolve(__dirname, "../../../../..")

afterEach(() => __setPromptOverrideSnapshotForTests(null))

describe("pattern prompt definitions (ADR-0236)", () => {
  it("has unique team.pattern ids", () => {
    const ids = PATTERN_PROMPTS.map((def) => def.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^team\.pattern\.[a-z-]+\.[a-z-]+$/)
  })

  it("covers every verifier lens", () => {
    expect(Object.keys(VERIFY_LENS_PROMPTS).sort()).toEqual(
      ["correctness", "perf", "repro", "security"].sort()
    )
  })

  it("ships defaults that satisfy their own contract", () => {
    for (const def of PATTERN_PROMPTS) {
      const issues =
        def.operation === "inspect-only" ? [] : validatePromptBody(def, def.defaultBody)
      expect({ id: def.id, issues }).toEqual({ id: def.id, issues: [] })
    }
  })

  it("keeps schema hints inspect-only and wording editable", () => {
    for (const def of PATTERN_PROMPTS) {
      if (def.id.endsWith("-schema")) {
        expect(def.operation).toBe("inspect-only")
        expect(def.scopes).toEqual([])
      } else {
        expect(def.operation).toBe("replace-template")
        expect(def.scopes).toEqual(["account", "workspace"])
      }
    }
  })

  it("names pattern consumers that resolve the definition", () => {
    for (const def of PATTERN_PROMPTS) {
      for (const consumer of def.consumers) {
        const file = path.join(repoRoot, consumer)
        expect({ consumer, exists: existsSync(file) }).toEqual({ consumer, exists: true })
        const source = readFileSync(file, "utf8")
        expect(source).toMatch(/\bresolvePrompt\(/)
      }
    }
  })
})

describe("freezePatternPromptScope", () => {
  it("freezes the loaded snapshot and the team's project", async () => {
    const snapshot = buildPromptOverrideSnapshot("test-db", [])
    __setPromptOverrideSnapshotForTests(snapshot)
    const scope = await freezePatternPromptScope({ team: { projectId: "ws-1" } as never })
    expect(scope).toEqual({ context: { workspaceId: "ws-1" }, snapshot })
  })
})
