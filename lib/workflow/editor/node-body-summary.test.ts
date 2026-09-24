import enNode from "@/i18n/messages/en/workflows/node.json"
import zhNode from "@/i18n/messages/zh-CN/workflows/node.json"
import type { Diagnostic } from "@/lib/workflow/diagnostics/types"
import { WORKFLOW_NODE_KINDS } from "@/types/workflow/visual"
import {
  missingRequiredFromDiagnostics,
  missingRequiredFromValidation,
  NODE_PREVIEW_FIELDS,
  NODE_PREVIEW_MAX_CHARS,
  nodeBodyPreview,
  requiredParamFields,
} from "./node-body-summary"

function paramDiag(field: string, messageKey: string, code: Diagnostic["code"] = "nodeParam") {
  return {
    id: `${code}|n1||${field}`,
    severity: "error",
    code,
    nodeId: "n1",
    field,
    messageKey,
  } satisfies Diagnostic
}

describe("nodeBodyPreview", () => {
  it("leads with an agent turn's prompt, not its system prompt", () => {
    expect(
      nodeBodyPreview({ systemPrompt: "You are terse.", prompt: "Summarize {{ $trigger.text }}" })
    ).toEqual({ field: "prompt", text: "Summarize {{ $trigger.text }}" })
  })

  it("falls through empty and whitespace-only values to the next content field", () => {
    expect(nodeBodyPreview({ prompt: "   ", content: "Ship notes" })).toEqual({
      field: "content",
      text: "Ship notes",
    })
  })

  it("ignores non-string values", () => {
    expect(nodeBodyPreview({ prompt: 42, text: ["a"] })).toBeNull()
  })

  it("returns null when nothing is configured yet", () => {
    expect(nodeBodyPreview({})).toBeNull()
    expect(nodeBodyPreview(undefined)).toBeNull()
  })

  it("previews a cron trigger's schedule and a sticky note's text", () => {
    expect(nodeBodyPreview({ cron: "0 9 * * 1-5" })?.field).toBe("cron")
    expect(nodeBodyPreview({ text: "Remember to rotate keys", color: "pink" })?.field).toBe("text")
  })

  it("caps very long content", () => {
    const preview = nodeBodyPreview({ prompt: "x".repeat(NODE_PREVIEW_MAX_CHARS + 50) })!
    expect(preview.text).toHaveLength(NODE_PREVIEW_MAX_CHARS + 1)
    expect(preview.text.endsWith("…")).toBe(true)
  })

  it("never lists a field twice", () => {
    expect(new Set(NODE_PREVIEW_FIELDS).size).toBe(NODE_PREVIEW_FIELDS.length)
  })
})

describe("missingRequiredFromDiagnostics", () => {
  it("names only empty required params, in diagnostic order, once each", () => {
    const diags: Diagnostic[] = [
      paramDiag("teamId", "workflows.validation.required"),
      paramDiag("cron", "workflows.validation.cronExpr"),
      paramDiag("objective", "workflows.validation.required"),
      paramDiag("teamId", "workflows.validation.required"),
      paramDiag("prompt", "workflows.validation.required", "exprUnknownNode"),
      paramDiag("_root", "workflows.validation.required"),
    ]
    expect(missingRequiredFromDiagnostics(diags)).toEqual(["teamId", "objective"])
  })

  it("is empty for a clean node", () => {
    expect(missingRequiredFromDiagnostics([])).toEqual([])
  })
})

describe("missingRequiredFromValidation", () => {
  it("reads the per-field validation result", () => {
    expect(
      missingRequiredFromValidation({
        prompt: { key: "required" },
        cron: { key: "cronExpr" },
        _root: { key: "required" },
      })
    ).toEqual(["prompt"])
    expect(missingRequiredFromValidation(undefined)).toEqual([])
  })
})

describe("requiredParamFields", () => {
  it("reports an agent turn's prompt", () => {
    expect(requiredParamFields("action.agent.turn")).toEqual(["prompt"])
  })

  it("reports nothing for a node with no required params", () => {
    expect(requiredParamFields("trigger.manual")).toEqual([])
  })
})

/**
 * The card names missing params through `workflows.node.paramLabels.<field>`.
 * A required param added to any built-in node schema without a label in both
 * locales would surface as its raw identifier — this keeps that from shipping.
 */
describe("paramLabels i18n coverage", () => {
  const required = Array.from(
    new Set(WORKFLOW_NODE_KINDS.flatMap((kind) => requiredParamFields(kind)))
  ).sort()

  it("finds required params to cover", () => {
    expect(required).toContain("prompt")
  })

  it.each([
    ["en", enNode.paramLabels as Record<string, string>],
    ["zh-CN", zhNode.paramLabels as Record<string, string>],
  ])("%s labels every required param of every built-in node", (_locale, labels) => {
    const missing = required.filter((field) => typeof labels[field] !== "string" || !labels[field])
    expect(missing).toEqual([])
  })

  it("keeps the two locales' label sets identical", () => {
    expect(Object.keys(zhNode.paramLabels).sort()).toEqual(Object.keys(enNode.paramLabels).sort())
  })
})
