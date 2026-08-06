/**
 * Tests for AI Shell types — validates the type contracts are correct and
 * the type guards / helpers work as expected.
 */

import type {
  ExecutionStep,
  ExecutionPlan,
  AiShellContext,
  AiShellMessage,
  ErrorAdvisory,
  StepStatus,
  PlanStatus,
} from "./types"

describe("ai-shell/types", () => {
  describe("ExecutionStep shape", () => {
    it("represents a pending step with all required fields", () => {
      const step: ExecutionStep = {
        index: 0,
        command: "git stash",
        description: "Stash current changes",
        status: "pending",
        exitCode: null,
        outputSnippet: null,
        requiresConfirmation: false,
      }
      expect(step.index).toBe(0)
      expect(step.status).toBe("pending")
      expect(step.exitCode).toBeNull()
    })

    it("represents a failed step with exit code and output", () => {
      const step: ExecutionStep = {
        index: 2,
        command: "npm run build",
        description: "Build the project",
        status: "failed",
        exitCode: 1,
        outputSnippet: "Error: Module not found\n  at resolve (/app/src/index.ts:5)",
        requiresConfirmation: false,
      }
      expect(step.exitCode).toBe(1)
      expect(step.outputSnippet).toContain("Module not found")
    })

    it("supports all valid step statuses", () => {
      const statuses: StepStatus[] = [
        "pending",
        "running",
        "succeeded",
        "failed",
        "skipped",
        "cancelled",
      ]
      expect(statuses).toHaveLength(6)
    })
  })

  describe("ExecutionPlan shape", () => {
    it("represents a complete plan", () => {
      const plan: ExecutionPlan = {
        id: "plan-abc123",
        intent: "Deploy to production",
        steps: [
          {
            index: 0,
            command: "git checkout main",
            description: "Switch to main branch",
            status: "succeeded",
            exitCode: 0,
            outputSnippet: null,
            requiresConfirmation: false,
          },
          {
            index: 1,
            command: "git pull origin main",
            description: "Pull latest changes",
            status: "pending",
            exitCode: null,
            outputSnippet: null,
            requiresConfirmation: false,
          },
        ],
        status: "executing",
        createdAt: Date.now(),
      }
      expect(plan.steps).toHaveLength(2)
      expect(plan.status).toBe("executing")
    })

    it("represents an error plan with error message", () => {
      const plan: ExecutionPlan = {
        id: "plan-err",
        intent: "do something",
        steps: [],
        status: "error",
        error: "Model refused to generate plan",
        createdAt: Date.now(),
      }
      expect(plan.error).toBeDefined()
      expect(plan.steps).toHaveLength(0)
    })

    it("supports all valid plan statuses", () => {
      const statuses: PlanStatus[] = [
        "generating",
        "ready",
        "executing",
        "completed",
        "cancelled",
        "error",
      ]
      expect(statuses).toHaveLength(6)
    })
  })

  describe("AiShellContext shape", () => {
    it("holds terminal context for the LLM", () => {
      const ctx: AiShellContext = {
        cwd: "/Users/dev/project",
        shell: "zsh",
        gitBranch: "feature/add-auth",
        recentOutput: "$ npm test\nAll tests passed.",
        recentCommands: ["npm install", "npm test"],
        platform: "darwin",
      }
      expect(ctx.shell).toBe("zsh")
      expect(ctx.recentCommands).toHaveLength(2)
    })

    it("handles null cwd and gitBranch", () => {
      const ctx: AiShellContext = {
        cwd: null,
        shell: "bash",
        gitBranch: null,
        recentOutput: "",
        recentCommands: [],
        platform: "linux",
      }
      expect(ctx.cwd).toBeNull()
      expect(ctx.gitBranch).toBeNull()
    })
  })

  describe("AiShellMessage shape", () => {
    it("represents a user message", () => {
      const msg: AiShellMessage = {
        id: "msg-1",
        role: "user",
        content: "Deploy to staging",
        timestamp: 1700000000000,
      }
      expect(msg.role).toBe("user")
    })

    it("represents an assistant message", () => {
      const msg: AiShellMessage = {
        id: "msg-2",
        role: "assistant",
        content: "I'll create a deployment plan.",
        timestamp: 1700000001000,
      }
      expect(msg.role).toBe("assistant")
    })
  })

  describe("ErrorAdvisory shape", () => {
    it("represents a fix suggestion", () => {
      const advisory: ErrorAdvisory = {
        stepIndex: 2,
        diagnosis: "The build failed because the dependency is not installed",
        suggestedFix: "npm install missing-package",
        retryAfterFix: true,
      }
      expect(advisory.suggestedFix).not.toBeNull()
      expect(advisory.retryAfterFix).toBe(true)
    })

    it("represents no fix available", () => {
      const advisory: ErrorAdvisory = {
        stepIndex: 0,
        diagnosis: "Permission denied — you need sudo access",
        suggestedFix: null,
        retryAfterFix: false,
      }
      expect(advisory.suggestedFix).toBeNull()
    })
  })
})
