/**
 * Barrel surface guard for the AI Shell library. The panel components import
 * the whole pipeline through `@/lib/terminal/ai-shell`, so a re-export dropped
 * during a refactor surfaces as an undefined call at runtime.
 */
import * as aiShell from "./index"
import {
  buildAiShellContext,
  MAX_RECENT_COMMANDS,
  MAX_RECENT_OUTPUT_LINES,
} from "./context-builder"
import { DEFAULT_MAX_STEPS, generatePlan } from "./plan-generator"
import { DEFAULT_STEP_TIMEOUT_MS, executePlan, executeStep } from "./plan-executor"
import { getErrorAdvisory } from "./error-advisor"

describe("lib/terminal/ai-shell barrel", () => {
  it("re-exports each pipeline stage by identity", () => {
    expect(aiShell.buildAiShellContext).toBe(buildAiShellContext)
    expect(aiShell.generatePlan).toBe(generatePlan)
    expect(aiShell.executeStep).toBe(executeStep)
    expect(aiShell.executePlan).toBe(executePlan)
    expect(aiShell.getErrorAdvisory).toBe(getErrorAdvisory)
  })

  it("re-exports the PII gate helpers — the context never reaches a model unchecked", () => {
    expect(typeof aiShell.isContextPiiSafe).toBe("function")
    expect(typeof aiShell.serializeContextForPiiCheck).toBe("function")
  })

  it("re-exports the prompt builders so tests and callers share one wording", () => {
    for (const name of [
      "buildPlanSystemPrompt",
      "buildPlanUserPrompt",
      "buildErrorAdvisorSystemPrompt",
      "buildErrorAdvisorPrompt",
    ]) {
      expect(typeof (aiShell as unknown as Record<string, unknown>)[name]).toBe("function")
    }
  })

  it("re-exports the budget constants by identity", () => {
    expect(aiShell.MAX_RECENT_OUTPUT_LINES).toBe(MAX_RECENT_OUTPUT_LINES)
    expect(aiShell.MAX_RECENT_COMMANDS).toBe(MAX_RECENT_COMMANDS)
    expect(aiShell.DEFAULT_MAX_STEPS).toBe(DEFAULT_MAX_STEPS)
    expect(aiShell.DEFAULT_STEP_TIMEOUT_MS).toBe(DEFAULT_STEP_TIMEOUT_MS)
  })

  it("exposes exactly the documented runtime surface", () => {
    expect(Object.keys(aiShell).sort()).toEqual([
      "DEFAULT_MAX_STEPS",
      "DEFAULT_STEP_TIMEOUT_MS",
      "MAX_LINE_LENGTH",
      "MAX_RECENT_COMMANDS",
      "MAX_RECENT_OUTPUT_LINES",
      "buildAiShellContext",
      "buildErrorAdvisorPrompt",
      "buildErrorAdvisorSystemPrompt",
      "buildPlanSystemPrompt",
      "buildPlanUserPrompt",
      "executePlan",
      "executeStep",
      "generatePlan",
      "getErrorAdvisory",
      "isContextPiiSafe",
      "serializeContextForPiiCheck",
    ])
  })
})
