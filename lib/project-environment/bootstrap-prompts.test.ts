import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  __setPromptOverrideSnapshotForTests,
  buildPromptOverrideSnapshot,
  type ActivePromptOverride,
} from "@/lib/prompts/snapshot"
import type { ProjectEnvironmentBootstrapAgent } from "@/types/project-environment"
import {
  BOOTSTRAP_PROMPT_SOURCES,
  BOOTSTRAP_SYSTEM_PROMPTS,
  resolveBootstrapSystemPrompt,
  type BootstrapRuntime,
} from "./bootstrap-prompts"

const RUNTIMES = Object.keys(BOOTSTRAP_PROMPT_SOURCES) as BootstrapRuntime[]

function override(
  runtime: BootstrapRuntime,
  scope: "account" | "workspace",
  targetId: string,
  body: string
): ActivePromptOverride {
  const def = BOOTSTRAP_SYSTEM_PROMPTS[runtime]
  return {
    bindingId: `pob-${runtime}-${scope}-${targetId}`,
    promptId: def.id,
    scope,
    targetId,
    revisionId: `por-${runtime}-${scope}-${targetId}`,
    body,
    contractVersion: def.contractVersion,
  }
}

function agent(
  patch: Partial<ProjectEnvironmentBootstrapAgent> = {}
): ProjectEnvironmentBootstrapAgent {
  return {
    enabled: true,
    task: "Install dependencies",
    baseUrl: "https://models.example.test/v1",
    model: "gpt-test",
    apiKeyEnv: "BOOTSTRAP_KEY",
    checks: [{ name: "node", command: "node --version" }],
    ...patch,
  }
}

afterEach(() => {
  __setPromptOverrideSnapshotForTests(null)
})

describe("bootstrap prompt definitions", () => {
  it.each(RUNTIMES)("mirrors the %s runtime's shipped default verbatim", (runtime) => {
    const source = readFileSync(join(process.cwd(), BOOTSTRAP_PROMPT_SOURCES[runtime]), "utf8")
    expect(source).toContain(BOOTSTRAP_SYSTEM_PROMPTS[runtime].defaultBody)
  })

  it("gives every runtime its own slot on the bootstrap host", () => {
    const ids = RUNTIMES.map((runtime) => BOOTSTRAP_SYSTEM_PROMPTS[runtime].id)
    expect(new Set(ids).size).toBe(RUNTIMES.length)
    for (const runtime of RUNTIMES) {
      const def = BOOTSTRAP_SYSTEM_PROMPTS[runtime]
      expect(def.hosts).toEqual(["bootstrap"])
      expect(def.scopes).toEqual(["account", "workspace"])
      expect(def.defaultBody.length).toBeLessThanOrEqual(def.maxChars!)
    }
  })
})

describe("resolveBootstrapSystemPrompt", () => {
  it("passes nothing without an override, so the runtime keeps its own text", async () => {
    __setPromptOverrideSnapshotForTests(buildPromptOverrideSnapshot("test-db", []))
    for (const runtime of RUNTIMES) {
      await expect(resolveBootstrapSystemPrompt(agent({ runtime }), "project-1")).resolves.toBe(
        undefined
      )
    }
  })

  it("passes an account override for the agent's runtime", async () => {
    __setPromptOverrideSnapshotForTests(
      buildPromptOverrideSnapshot("test-db", [
        override("bash", "account", "", "Bash account override."),
      ])
    )
    await expect(
      resolveBootstrapSystemPrompt(agent({ runtime: "bash" }), "project-1")
    ).resolves.toBe("Bash account override.")
    // Another runtime's slot is untouched.
    await expect(
      resolveBootstrapSystemPrompt(agent({ runtime: "powershell" }), "project-1")
    ).resolves.toBe(undefined)
  })

  it("treats a missing runtime as native", async () => {
    __setPromptOverrideSnapshotForTests(
      buildPromptOverrideSnapshot("test-db", [
        override("native", "account", "", "Native account override."),
      ])
    )
    await expect(resolveBootstrapSystemPrompt(agent(), undefined)).resolves.toBe(
      "Native account override."
    )
  })

  it("prefers the environment's workspace override over the account one", async () => {
    __setPromptOverrideSnapshotForTests(
      buildPromptOverrideSnapshot("test-db", [
        override("native", "account", "", "Account text."),
        override("native", "workspace", "project-1", "Workspace text."),
      ])
    )
    await expect(resolveBootstrapSystemPrompt(agent(), "project-1")).resolves.toBe(
      "Workspace text."
    )
    await expect(resolveBootstrapSystemPrompt(agent(), "project-2")).resolves.toBe("Account text.")
  })

  it("keeps the environment's own prompt over any override", async () => {
    __setPromptOverrideSnapshotForTests(
      buildPromptOverrideSnapshot("test-db", [
        override("native", "workspace", "project-1", "Workspace text."),
      ])
    )
    await expect(
      resolveBootstrapSystemPrompt(agent({ systemPrompt: "Environment text." }), "project-1")
    ).resolves.toBe("Environment text.")
    // An explicitly empty prompt is also the owner's choice.
    await expect(
      resolveBootstrapSystemPrompt(agent({ systemPrompt: "" }), "project-1")
    ).resolves.toBe("")
  })
})
