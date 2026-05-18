import {
  workflowDesignerAgent,
  workflowDebuggerAgent,
  workflowRefactorerAgent,
  workflowDocWriterAgent,
  workflowEditorSubagents,
} from "./index"

describe("workflow subagent definitions", () => {
  it("every subagent exposes a description, prompt, and tools list", () => {
    for (const agent of [
      workflowDesignerAgent,
      workflowDebuggerAgent,
      workflowRefactorerAgent,
      workflowDocWriterAgent,
    ]) {
      expect(agent.description.length).toBeGreaterThan(30)
      expect(agent.prompt.length).toBeGreaterThan(200)
      expect(Array.isArray(agent.tools)).toBe(true)
      expect(agent.tools!.length).toBeGreaterThan(0)
    }
  })

  it("designer + refactorer have BOTH read AND mutate tools (so they can author)", () => {
    for (const agent of [workflowDesignerAgent, workflowRefactorerAgent]) {
      expect(agent.tools).toContain("mcp__cognia-plugin-tools__wf_read_graph")
      expect(agent.tools).toContain("mcp__cognia-plugin-tools__wf_add_node")
      expect(agent.tools).toContain("mcp__cognia-plugin-tools__wf_batch_apply")
    }
  })

  it("debugger has ONLY read tools (no write surface)", () => {
    const writeTools = workflowDebuggerAgent.tools!.filter(
      (t) =>
        t.includes("wf_add_node") ||
        t.includes("wf_remove_node") ||
        t.includes("wf_configure_node") ||
        t.includes("wf_connect_edge") ||
        t.includes("wf_disconnect_edge") ||
        t.includes("wf_batch_apply") ||
        t.includes("wf_auto_layout") ||
        t.includes("wf_run_workflow") ||
        t.includes("wf_run_from_step")
    )
    expect(writeTools).toEqual([])
  })

  it("no subagent surfaces the run-* tools (run control stays with the main agent for approval)", () => {
    for (const agent of [
      workflowDesignerAgent,
      workflowDebuggerAgent,
      workflowRefactorerAgent,
      workflowDocWriterAgent,
    ]) {
      const runTools = agent.tools!.filter(
        (t) => t.includes("wf_run") || t.includes("wf_cancel_run")
      )
      expect(runTools).toEqual([])
    }
  })

  it("workflowEditorSubagents() returns all four keyed for SDK consumption", () => {
    const map = workflowEditorSubagents()
    expect(Object.keys(map).sort()).toEqual([
      "workflow-debugger",
      "workflow-designer",
      "workflow-doc-writer",
      "workflow-refactorer",
    ])
  })
})
