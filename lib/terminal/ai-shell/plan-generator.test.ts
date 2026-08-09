/**
 * Tests for the AI Shell plan generator.
 */

import {
  generatePlan,
  buildPlanSystemPrompt,
  buildPlanUserPrompt,
  DEFAULT_MAX_STEPS,
  __resetPlanIdCounterForTesting,
} from "./plan-generator"
import type { AiShellContext } from "./types"
import type { LlmClient } from "@/lib/twin/distill/llm"

function makeContext(overrides?: Partial<AiShellContext>): AiShellContext {
  return {
    cwd: "/home/user/project",
    shell: "zsh",
    gitBranch: "main",
    recentOutput: "$ ls\nREADME.md  src  package.json",
    recentCommands: ["npm install", "npm test"],
    platform: "darwin",
    ...overrides,
  }
}

function mockClient(response: string): LlmClient {
  return {
    async complete() {
      return response
    },
    async *stream() {
      yield response
    },
    getUsageSnapshot: () => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
  }
}

function mockStreamClient(chunks: string[]): LlmClient {
  return {
    async complete() {
      return chunks.join("")
    },
    async *stream() {
      for (const chunk of chunks) yield chunk
    },
    getUsageSnapshot: () => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
  }
}

const VALID_PLAN_RESPONSE = JSON.stringify({
  reasoning: "Deploy by switching to staging, pulling, and running deploy script.",
  steps: [
    { command: "git checkout staging", description: "Switch to staging branch" },
    { command: "git pull origin staging", description: "Pull latest changes" },
    {
      command: "./deploy.sh --env staging",
      description: "Run deploy script",
      requiresConfirmation: true,
    },
  ],
})

describe("ai-shell/plan-generator", () => {
  beforeEach(() => {
    __resetPlanIdCounterForTesting()
  })

  describe("buildPlanSystemPrompt", () => {
    it("includes the max steps limit", () => {
      const prompt = buildPlanSystemPrompt(10)
      expect(prompt).toContain("Maximum 10 steps")
    })

    it("describes the expected JSON response format", () => {
      const prompt = buildPlanSystemPrompt(DEFAULT_MAX_STEPS)
      expect(prompt).toContain('"steps"')
      expect(prompt).toContain('"command"')
      expect(prompt).toContain('"description"')
      expect(prompt).toContain('"requiresConfirmation"')
    })
  })

  describe("buildPlanUserPrompt", () => {
    it("includes terminal context", () => {
      const ctx = makeContext()
      const prompt = buildPlanUserPrompt("deploy to staging", ctx)

      expect(prompt).toContain("/home/user/project")
      expect(prompt).toContain("zsh")
      expect(prompt).toContain("main")
      expect(prompt).toContain("darwin")
      expect(prompt).toContain("deploy to staging")
    })

    it("includes recent commands", () => {
      const ctx = makeContext({ recentCommands: ["git status", "npm build"] })
      const prompt = buildPlanUserPrompt("fix the error", ctx)

      expect(prompt).toContain("git status")
      expect(prompt).toContain("npm build")
    })

    it("omits null cwd and branch", () => {
      const ctx = makeContext({ cwd: null, gitBranch: null })
      const prompt = buildPlanUserPrompt("do something", ctx)

      expect(prompt).not.toContain("Working directory:")
      expect(prompt).not.toContain("Git branch:")
    })

    it("includes recent output (truncated to 10 lines)", () => {
      const lines = Array.from({ length: 20 }, (_, i) => `line-${i}`)
      const ctx = makeContext({ recentOutput: lines.join("\n") })
      const prompt = buildPlanUserPrompt("analyze", ctx)

      // Should only have last 10 lines
      expect(prompt).toContain("line-10")
      expect(prompt).toContain("line-19")
      expect(prompt).not.toContain("line-0")
    })
  })

  describe("generatePlan", () => {
    it("generates a valid plan from LLM response", async () => {
      const client = mockClient(VALID_PLAN_RESPONSE)
      const plan = await generatePlan("deploy to staging", makeContext(), {
        getClient: () => client,
      })

      expect(plan.status).toBe("ready")
      expect(plan.intent).toBe("deploy to staging")
      expect(plan.steps).toHaveLength(3)
      expect(plan.steps[0].command).toBe("git checkout staging")
      expect(plan.steps[0].status).toBe("pending")
      expect(plan.steps[0].index).toBe(0)
      expect(plan.steps[2].requiresConfirmation).toBe(true)
    })

    it("returns error when no client available", async () => {
      const plan = await generatePlan("do thing", makeContext(), { getClient: () => null })

      expect(plan.status).toBe("error")
      expect(plan.error).toContain("No LLM client")
    })

    it("returns error when PII gate rejects", async () => {
      const client = mockClient(VALID_PLAN_RESPONSE)
      const plan = await generatePlan("deploy", makeContext(), {
        getClient: () => client,
        isPiiSafe: () => false,
      })

      expect(plan.status).toBe("error")
      expect(plan.error).toContain("sensitive information")
    })

    it("returns cancelled when signal is already aborted", async () => {
      const controller = new AbortController()
      controller.abort()
      const client = mockClient(VALID_PLAN_RESPONSE)

      const plan = await generatePlan(
        "deploy",
        makeContext(),
        { getClient: () => client },
        { signal: controller.signal }
      )

      expect(plan.status).toBe("cancelled")
    })

    it("returns error on invalid JSON response", async () => {
      const client = mockClient("Sorry, I cannot help with that.")
      const plan = await generatePlan("do thing", makeContext(), { getClient: () => client })

      expect(plan.status).toBe("error")
    })

    it("returns error when model returns invalid plan shape", async () => {
      const client = mockClient(JSON.stringify({ steps: "not an array" }))
      const plan = await generatePlan("do thing", makeContext(), { getClient: () => client })

      expect(plan.status).toBe("error")
    })

    it("handles model returning empty steps with reasoning", async () => {
      const response = JSON.stringify({
        reasoning: "This request is too dangerous",
        steps: [],
      })
      const client = mockClient(response)
      const plan = await generatePlan("rm -rf /", makeContext(), { getClient: () => client })

      expect(plan.status).toBe("error")
      expect(plan.error).toContain("dangerous")
    })

    it("respects maxSteps option", async () => {
      const manySteps = Array.from({ length: 30 }, (_, i) => ({
        command: `step-${i}`,
        description: `Step ${i}`,
      }))
      const response = JSON.stringify({ reasoning: "lots", steps: manySteps })
      const client = mockClient(response)

      const plan = await generatePlan(
        "many steps",
        makeContext(),
        { getClient: () => client },
        { maxSteps: 5 }
      )

      expect(plan.steps).toHaveLength(5)
    })

    it("uses streaming when client.stream is available", async () => {
      const client = mockStreamClient([
        '{"reasoning": "ok", ',
        '"steps": [{"command": "echo hi", "description": "say hi"}]}',
      ])
      const plan = await generatePlan("greet", makeContext(), { getClient: () => client })

      expect(plan.status).toBe("ready")
      expect(plan.steps[0].command).toBe("echo hi")
    })

    it("calls onStream callback with generating status", async () => {
      const client = mockClient(VALID_PLAN_RESPONSE)
      const streamCalls: Array<Partial<{ status: string }>> = []

      await generatePlan(
        "deploy",
        makeContext(),
        { getClient: () => client },
        undefined,
        (partial) => streamCalls.push(partial)
      )

      expect(streamCalls.length).toBeGreaterThanOrEqual(1)
      expect(streamCalls[0].status).toBe("generating")
    })

    it("handles client.complete throwing", async () => {
      const client: LlmClient = {
        async complete() {
          throw new Error("Network timeout")
        },
        getUsageSnapshot: () => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
      }

      const plan = await generatePlan("deploy", makeContext(), { getClient: () => client })

      expect(plan.status).toBe("error")
      expect(plan.error).toContain("Network timeout")
    })

    it("uses custom generateId", async () => {
      const client = mockClient(VALID_PLAN_RESPONSE)
      const plan = await generatePlan("deploy", makeContext(), {
        getClient: () => client,
        generateId: () => "custom-id-123",
      })

      expect(plan.id).toBe("custom-id-123")
    })

    it("normalizes step fields", async () => {
      const response = JSON.stringify({
        reasoning: "ok",
        steps: [{ command: "  echo hello  ", description: "  say hello  " }, { command: "pwd" }],
      })
      const client = mockClient(response)
      const plan = await generatePlan("test", makeContext(), { getClient: () => client })

      expect(plan.steps[0].command).toBe("echo hello")
      expect(plan.steps[0].description).toBe("say hello")
      expect(plan.steps[1].description).toBe("")
      expect(plan.steps[1].requiresConfirmation).toBe(false)
    })
  })
})
