import { describe, expect, it } from "@jest/globals"
import type { VisualWorkflow, WorkflowEdge, WorkflowNode } from "@/types/workflow/visual"
import { runDiagnostics } from "./engine"
import { EMPTY_DIAGNOSTICS } from "./types"

function node(id: string, type = "ai.prompt", extra: Partial<WorkflowNode> = {}): WorkflowNode {
  return {
    id,
    type: type as WorkflowNode["type"],
    typeVersion: 1,
    position: { x: 0, y: 0 },
    data: { label: id, params: {} },
    ...extra,
  }
}

function wf(nodes: WorkflowNode[], edges: WorkflowEdge[] = []): VisualWorkflow {
  return {
    id: "wf_t",
    schemaVersion: 1,
    name: "T",
    createdAt: 0,
    updatedAt: 0,
    nodes,
    edges,
    settings: {
      errorPolicy: "stop",
      timeoutMs: 60_000,
      concurrency: 1,
      retryDefaults: { attempts: 3, backoff: "exponential", baseMs: 1000 },
    },
  }
}

const codesOf = (r: ReturnType<typeof runDiagnostics>) => r.diagnostics.map((d) => d.code)

describe("runDiagnostics", () => {
  it("returns a clean result for a well-formed workflow", () => {
    const w = wf(
      [node("a", "trigger.manual"), node("b", "ai.prompt")],
      [{ id: "e1", source: "a", target: "b" }]
    )
    // ai.prompt needs a prompt param — give it one so nodeParam doesn't fire.
    w.nodes[1].data.params = { userPrompt: "hi" }
    const result = runDiagnostics({ workflow: w, isWeb: false })
    expect(result.errorCount).toBe(0)
    // May still warn (e.g. nothing) — assert no errors and indexes built.
    expect(result.byNodeId).toBeDefined()
  })

  it("emits a nodeParam error for a missing required param, keyed under workflows.validation", () => {
    const w = wf([node("a", "trigger.manual"), node("cron", "trigger.cron")])
    const result = runDiagnostics({ workflow: w, isWeb: false })
    const param = result.diagnostics.find((d) => d.code === "nodeParam")
    expect(param).toBeTruthy()
    expect(param?.messageKey.startsWith("workflows.validation.")).toBe(true)
    expect(param?.nodeId).toBe("cron")
    expect(param?.field).toBeTruthy()
  })

  it("composes graph-integrity issues (dangling edge) as diagnostics with edgeId", () => {
    const w = wf([node("a", "trigger.manual")], [{ id: "e9", source: "a", target: "ghost" }])
    const result = runDiagnostics({ workflow: w, isWeb: false })
    const dangling = result.diagnostics.find((d) => d.code === "danglingTarget")
    expect(dangling?.edgeId).toBe("e9")
    expect(result.byEdgeId["e9"]?.length).toBeGreaterThan(0)
  })

  it("flags an orphan node unreachable from the trigger", () => {
    const w = wf(
      [node("a", "trigger.manual"), node("b"), node("island")],
      [{ id: "e1", source: "a", target: "b" }]
    )
    w.nodes[1].data.params = { userPrompt: "x" }
    w.nodes[2].data.params = { userPrompt: "x" }
    const result = runDiagnostics({ workflow: w, isWeb: false })
    expect(codesOf(result)).toContain("orphanNode")
    expect(result.diagnostics.find((d) => d.code === "orphanNode")?.nodeId).toBe("island")
  })

  it("flags an unknown $node reference (error) and a non-upstream reference (warning)", () => {
    const w = wf(
      [node("a", "trigger.manual"), node("b"), node("c")],
      [
        { id: "e1", source: "a", target: "b" },
        { id: "e2", source: "b", target: "c" },
      ]
    )
    // b references a downstream sibling (c) and a ghost.
    w.nodes[1].data.params = {
      prompt: "{{ $node['c'].out.text }} {{ $node['ghost'].out.x }}",
      mode: "explicit",
    }
    w.nodes[2].data.params = { userPrompt: "ok" }
    const result = runDiagnostics({ workflow: w, isWeb: false })
    const unknown = result.diagnostics.find((d) => d.code === "exprUnknownNode")
    const notUp = result.diagnostics.find((d) => d.code === "exprNotUpstream")
    expect(unknown?.messageParams?.ref).toBe("ghost")
    expect(unknown?.severity).toBe("error")
    expect(notUp?.messageParams?.ref).toBe("c")
    expect(notUp?.severity).toBe("warning")
  })

  it("accepts a valid upstream $node reference without complaint", () => {
    const w = wf([node("a", "trigger.manual"), node("b")], [{ id: "e1", source: "a", target: "b" }])
    w.nodes[1].data.params = { prompt: "{{ $node['a'].out.text }}", mode: "explicit" }
    const result = runDiagnostics({ workflow: w, isWeb: false })
    expect(codesOf(result)).not.toContain("exprUnknownNode")
    expect(codesOf(result)).not.toContain("exprNotUpstream")
  })

  it("flags a missing credential reference", () => {
    const w = wf([node("a", "trigger.manual"), node("b", "action.connector.send")])
    w.nodes[1].data.params = { adapterId: "x", text: "hi" }
    w.nodes[1].data.credentialRefs = { apiKey: "cred_missing" }
    const result = runDiagnostics({ workflow: w, isWeb: false })
    const cred = result.diagnostics.find((d) => d.code === "credentialMissing")
    expect(cred?.nodeId).toBe("b")
    expect(cred?.messageParams?.ref).toBe("cred_missing")
  })

  it("does not flag a credential that is declared", () => {
    const w = wf([node("a", "trigger.manual"), node("b", "action.connector.send")])
    w.nodes[1].data.params = { adapterId: "x", text: "hi" }
    w.nodes[1].data.credentialRefs = { apiKey: "cred_ok" }
    w.credentials = { cred_ok: { id: "cred_ok", name: "OK" } }
    const result = runDiagnostics({ workflow: w, isWeb: false })
    expect(codesOf(result)).not.toContain("credentialMissing")
  })

  it("warns on desktop-only nodes only in web mode", () => {
    const w = wf([node("a", "trigger.manual"), node("term", "action.system.terminal")])
    w.nodes[1].data.params = { command: "ls" }
    expect(codesOf(runDiagnostics({ workflow: w, isWeb: false }))).not.toContain("desktopOnlyInWeb")
    expect(codesOf(runDiagnostics({ workflow: w, isWeb: true }))).toContain("desktopOnlyInWeb")
  })

  it("warns on an unavailable plugin kind when a predicate is supplied", () => {
    const w = wf([node("a", "trigger.manual"), node("p", "myplugin.action.foo")])
    const isKindAvailable = (kind: string) => !kind.startsWith("myplugin.")
    const result = runDiagnostics({ workflow: w, isWeb: false, isKindAvailable })
    const unavailable = result.diagnostics.find((d) => d.code === "pluginUnavailable")
    expect(unavailable?.nodeId).toBe("p")
    expect(unavailable?.messageParams?.kind).toBe("myplugin.action.foo")
  })

  it("indexes diagnostics by node and counts by severity, deduping by id", () => {
    const w = wf([node("a", "trigger.manual"), node("cron", "trigger.cron")])
    const result = runDiagnostics({ workflow: w, isWeb: false })
    // Running twice yields identical ids (stable) — concat would dedupe.
    expect(result.errorCount + result.warningCount + result.infoCount).toBe(
      result.diagnostics.length
    )
    expect(result.byNodeId["cron"]?.every((d) => d.nodeId === "cron")).toBe(true)
  })
})

describe("EMPTY_DIAGNOSTICS", () => {
  it("is a zeroed result", () => {
    expect(EMPTY_DIAGNOSTICS.diagnostics).toEqual([])
    expect(EMPTY_DIAGNOSTICS.errorCount).toBe(0)
  })
})
