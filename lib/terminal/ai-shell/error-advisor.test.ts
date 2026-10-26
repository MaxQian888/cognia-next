/**
 * Tests for the AI Shell error advisor.
 */

import {
  getErrorAdvisory,
  buildErrorAdvisorSystemPrompt,
  buildErrorAdvisorPrompt,
} from "./error-advisor"
import type { ExecutionStep, AiShellContext } from "./types"
import type { LlmClient } from "@/lib/twin/distill/llm"
import {
  __setPromptOverrideSnapshotForTests,
  buildPromptOverrideSnapshot,
} from "@/lib/prompts/snapshot"

function makeFailedStep(overrides?: Partial<ExecutionStep>): ExecutionStep {
  return {
    index: 2,
    command: "npm run build",
    description: "Build the project",
    status: "failed",
    exitCode: 1,
    outputSnippet: "Error: Cannot find module 'react'\n  at resolve (/app/node_modules)",
    requiresConfirmation: false,
    ...overrides,
  }
}

function makeMinimalContext(): Pick<AiShellContext, "cwd" | "shell" | "platform"> {
  return { cwd: "/home/user/project", shell: "zsh", platform: "darwin" }
}

function mockClient(response: string): LlmClient {
  return {
    async complete() {
      return response
    },
    getUsageSnapshot: () => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
  }
}

describe("ai-shell/error-advisor", () => {
  afterEach(() => {
    __setPromptOverrideSnapshotForTests(null)
  })

  describe("buildErrorAdvisorSystemPrompt", () => {
    it("includes expected JSON format description", () => {
      const prompt = buildErrorAdvisorSystemPrompt()
      expect(prompt).toContain('"diagnosis"')
      expect(prompt).toContain('"suggestedFix"')
      expect(prompt).toContain('"retryAfterFix"')
    })
  })

  describe("buildErrorAdvisorPrompt", () => {
    it("includes the failed command", () => {
      const step = makeFailedStep()
      const prompt = buildErrorAdvisorPrompt(step, makeMinimalContext())

      expect(prompt).toContain("npm run build")
      expect(prompt).toContain("Exit code: 1")
      expect(prompt).toContain("Cannot find module")
    })

    it("handles null exit code", () => {
      const step = makeFailedStep({ exitCode: null })
      const prompt = buildErrorAdvisorPrompt(step, makeMinimalContext())

      expect(prompt).not.toContain("Exit code:")
    })

    it("handles null output snippet", () => {
      const step = makeFailedStep({ outputSnippet: null })
      const prompt = buildErrorAdvisorPrompt(step, makeMinimalContext())

      expect(prompt).not.toContain("Output:")
    })

    it("includes context information", () => {
      const prompt = buildErrorAdvisorPrompt(makeFailedStep(), makeMinimalContext())

      expect(prompt).toContain("/home/user/project")
      expect(prompt).toContain("zsh")
      expect(prompt).toContain("darwin")
    })
  })

  describe("getErrorAdvisory", () => {
    it("sends the published error advisor prompt override to the model", async () => {
      const body = 'Advisor override. "diagnosis" "suggestedFix" "retryAfterFix"'
      __setPromptOverrideSnapshotForTests(
        buildPromptOverrideSnapshot("ai-shell-test", [
          {
            bindingId: "advisor-override",
            revisionId: "advisor-revision",
            promptId: "developer.ai-shell.error-advisor",
            scope: "account",
            targetId: "",
            contractVersion: 1,
            body,
          },
        ])
      )
      const client = mockClient(
        JSON.stringify({
          diagnosis: "Missing dependency",
          suggestedFix: null,
          retryAfterFix: false,
        })
      )
      const send = jest.spyOn(client, "complete")

      const advisory = await getErrorAdvisory(makeFailedStep(), makeMinimalContext(), {
        getClient: () => client,
      })

      expect(advisory?.diagnosis).toBe("Missing dependency")
      expect(send).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ system: body })
      )
    })

    it("PII-gates both the resolved system prompt and terminal context before sending", async () => {
      const client = mockClient("{}")
      const send = jest.spyOn(client, "complete")
      const isPiiSafe = jest.fn(
        (text: string) => !text.includes("terminal error diagnosis assistant")
      )

      const advisory = await getErrorAdvisory(makeFailedStep(), makeMinimalContext(), {
        getClient: () => client,
        isPiiSafe,
      })

      expect(advisory).toBeNull()
      expect(isPiiSafe).toHaveBeenCalledWith(expect.stringContaining("npm run build"))
      expect(isPiiSafe).toHaveBeenCalledWith(
        expect.stringContaining("terminal error diagnosis assistant")
      )
      expect(send).not.toHaveBeenCalled()
    })

    it("returns advisory with fix suggestion", async () => {
      const response = JSON.stringify({
        diagnosis: "The react module is not installed",
        suggestedFix: "npm install react",
        retryAfterFix: true,
      })
      const client = mockClient(response)

      const advisory = await getErrorAdvisory(makeFailedStep(), makeMinimalContext(), {
        getClient: () => client,
      })

      expect(advisory).not.toBeNull()
      expect(advisory!.diagnosis).toBe("The react module is not installed")
      expect(advisory!.suggestedFix).toBe("npm install react")
      expect(advisory!.retryAfterFix).toBe(true)
      expect(advisory!.stepIndex).toBe(2)
    })

    it("returns advisory with no fix available", async () => {
      const response = JSON.stringify({
        diagnosis: "Permission denied — need sudo",
        suggestedFix: null,
        retryAfterFix: false,
      })
      const client = mockClient(response)

      const advisory = await getErrorAdvisory(makeFailedStep(), makeMinimalContext(), {
        getClient: () => client,
      })

      expect(advisory).not.toBeNull()
      expect(advisory!.suggestedFix).toBeNull()
      expect(advisory!.retryAfterFix).toBe(false)
    })

    it("returns null when no client available", async () => {
      const advisory = await getErrorAdvisory(makeFailedStep(), makeMinimalContext(), {
        getClient: () => null,
      })

      expect(advisory).toBeNull()
    })

    it("returns null when PII gate rejects", async () => {
      const client = mockClient("{}")
      const advisory = await getErrorAdvisory(makeFailedStep(), makeMinimalContext(), {
        getClient: () => client,
        isPiiSafe: () => false,
      })

      expect(advisory).toBeNull()
    })

    it("returns null when signal is already aborted", async () => {
      const controller = new AbortController()
      controller.abort()
      const client = mockClient("{}")

      const advisory = await getErrorAdvisory(
        makeFailedStep(),
        makeMinimalContext(),
        { getClient: () => client },
        controller.signal
      )

      expect(advisory).toBeNull()
    })

    it("returns null on invalid LLM response", async () => {
      const client = mockClient("I don't know what happened")

      const advisory = await getErrorAdvisory(makeFailedStep(), makeMinimalContext(), {
        getClient: () => client,
      })

      expect(advisory).toBeNull()
    })

    it("returns null on malformed JSON response", async () => {
      // Valid JSON but wrong shape
      const client = mockClient(JSON.stringify({ answer: 42 }))

      const advisory = await getErrorAdvisory(makeFailedStep(), makeMinimalContext(), {
        getClient: () => client,
      })

      expect(advisory).toBeNull()
    })

    it("returns null when client throws", async () => {
      const client: LlmClient = {
        async complete() {
          throw new Error("Network error")
        },
        getUsageSnapshot: () => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
      }

      const advisory = await getErrorAdvisory(makeFailedStep(), makeMinimalContext(), {
        getClient: () => client,
      })

      expect(advisory).toBeNull()
    })

    it("trims whitespace from fix and diagnosis", async () => {
      const response = JSON.stringify({
        diagnosis: "  extra spaces  ",
        suggestedFix: "  npm install  ",
        retryAfterFix: true,
      })
      const client = mockClient(response)

      const advisory = await getErrorAdvisory(makeFailedStep(), makeMinimalContext(), {
        getClient: () => client,
      })

      expect(advisory!.diagnosis).toBe("extra spaces")
      expect(advisory!.suggestedFix).toBe("npm install")
    })
  })
})
