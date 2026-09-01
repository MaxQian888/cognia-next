import {
  workflowDesignerAgent,
  workflowDebuggerAgent,
  workflowRefactorerAgent,
  workflowDocWriterAgent,
  workflowEditorSubagents,
  resolveAllSubagents,
  resolveDispatchableSubagents,
  getDispatchableSubagentDef,
} from "./index"
import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"
import type { SubAgentTemplate } from "@/types/agent/sub-agent"
import { builtinAgentById } from "@/lib/agent/builtin-catalog/catalog"
import {
  registerSubagent,
  unregisterSubagentsByPlugin,
} from "@/lib/plugin/registries/subagent-registry"

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
    }
    // Designer prefers wf_propose_batch (Workflow Copilot proposal flow);
    // refactorer keeps wf_batch_apply because its small in-place edits
    // already cite which subgraph they touch.
    expect(workflowDesignerAgent.tools).toContain("mcp__cognia-plugin-tools__wf_propose_batch")
    expect(workflowDesignerAgent.tools).toContain("mcp__cognia-plugin-tools__wf_apply_template")
    expect(workflowRefactorerAgent.tools).toContain("mcp__cognia-plugin-tools__wf_batch_apply")
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

describe("resolveAllSubagents — direct context", () => {
  it("includes user (non-built-in) templates; excludes seeded built-ins + workflow-* agents", () => {
    const userTpl: SubAgentTemplate = {
      id: "user-direct-1",
      name: "My Reviewer",
      description: "reviews my code",
      category: "coding",
      taskTemplate: "Review {{code}}",
      config: { systemPrompt: "You review code.", tools: ["x"], model: "sonnet", maxSteps: 5 },
      isBuiltIn: false,
    }
    useSubagentRuntimeStore.getState().addTemplate(userTpl)
    try {
      const direct = resolveAllSubagents({ context: "direct" })
      expect(direct["template:my-reviewer"]).toEqual({
        description: "reviews my code",
        prompt: "You review code.",
        tools: ["x"],
        model: "sonnet",
        maxTurns: 5,
      })
      // The workflow-* editor built-ins are NOT injected into direct chat.
      expect(direct["workflow-designer"]).toBeUndefined()
      // Seeded built-in templates (isBuiltIn) are excluded (Settings starting
      // points, not auto-injected every turn).
      expect(direct["template:web-research"]).toBeUndefined()
    } finally {
      useSubagentRuntimeStore.getState().deleteTemplate("user-direct-1")
    }
  })

  it("excludes external-backed templates from the NATIVE agents map (ADR-0090 Phase 7)", () => {
    // A native (SDK Task) subagent inherits the parent's route/provider/
    // credential; an external backing cannot be honored there, so the def
    // must NOT ride the native map — it stays reachable through the
    // orchestrated dispatch_agent rail (resolveDispatchableSubagents).
    const extTpl: SubAgentTemplate = {
      id: "user-ext-1",
      name: "External Coder",
      description: "codes via an external CLI",
      category: "coding",
      taskTemplate: "build {{x}}",
      config: {
        systemPrompt: "You code.",
        externalPresetId: "claude-code",
        mcpServerIds: ["github", "linear"],
      },
      isBuiltIn: false,
    }
    useSubagentRuntimeStore.getState().addTemplate(extTpl)
    try {
      const direct = resolveAllSubagents({ context: "direct" })
      expect(direct["template:external-coder"]).toBeUndefined()
      const dispatchable = resolveDispatchableSubagents().find(
        (x) => x.id === "template:external-coder"
      )
      expect(dispatchable?.def).toMatchObject({ externalPresetId: "claude-code" })
    } finally {
      useSubagentRuntimeStore.getState().deleteTemplate("user-ext-1")
    }
  })
})

describe("resolveDispatchableSubagents — built-in dispatch targets", () => {
  it("includes all four workflow-* built-ins as dispatchable defs", () => {
    const ids = resolveDispatchableSubagents().map((x) => x.id)
    expect(ids).toEqual(
      expect.arrayContaining([
        "workflow-designer",
        "workflow-debugger",
        "workflow-refactorer",
        "workflow-doc-writer",
      ])
    )
  })

  it("projects a built-in with description + prompt + display name", () => {
    const def = getDispatchableSubagentDef("workflow-designer")
    expect(def).toBeDefined()
    expect(def?.name).toBe("Workflow Designer")
    expect(def?.description).toBe(workflowDesignerAgent.description)
    expect(def?.prompt).toBe(workflowDesignerAgent.prompt)
    // Built-ins stay leaves — they do not opt into further nesting.
    expect(def?.allowNesting).toBeUndefined()
  })

  // The parity that this catalog exists for: the app and the CLI used to write
  // their own `Explore` and `Plan`, with different prompts and descriptions, so
  // one name meant two different agents depending on which shell dispatched it.
  it("dispatches the shared catalog's Explore and Plan, not a second copy", () => {
    for (const id of ["Explore", "Plan"]) {
      const entry = builtinAgentById(id)
      const def = getDispatchableSubagentDef(id)
      expect(entry).toBeDefined()
      expect(def?.prompt).toBe(entry!.prompt)
      expect(def?.description).toBe(entry!.description)
      // Read-only by construction, so the prompt slipping cannot let them edit.
      expect(def?.tools?.length).toBeGreaterThan(0)
    }
  })

  // ADR-0161 precedence: a built-in is a default you can replace. Naming your
  // own agent `Explore` replaces `Explore` rather than sitting beside it under
  // a second name.
  it("lets a user template claim a built-in id and shadow it", () => {
    const shadow: SubAgentTemplate = {
      id: "user-shadow-explore",
      name: "Explore",
      description: "my own explorer",
      category: "research",
      taskTemplate: "explore {{x}}",
      config: { systemPrompt: "mine." },
      isBuiltIn: false,
    }
    useSubagentRuntimeStore.getState().addTemplate(shadow)
    try {
      const rows = resolveDispatchableSubagents().filter((x) => x.id === "Explore")
      expect(rows).toHaveLength(1)
      expect(rows[0].def.description).toBe("my own explorer")
      expect(resolveDispatchableSubagents().map((x) => x.id)).not.toContain("template:explore")
    } finally {
      useSubagentRuntimeStore.getState().deleteTemplate("user-shadow-explore")
    }
  })

  // Plugin ids stay namespaced: isolation there is a security property, not a
  // naming convention, so a plugin cannot claim a built-in's name.
  it("keeps a plugin subagent namespaced even when it names a built-in", () => {
    registerSubagent(
      "Explore",
      { id: "Explore", name: "Explore", description: "plugin explorer", prompt: "p" },
      { pluginId: "acme" }
    )
    try {
      const ids = resolveDispatchableSubagents().map((x) => x.id)
      expect(ids).toContain("acme:Explore")
      expect(getDispatchableSubagentDef("Explore")?.description).not.toBe("plugin explorer")
    } finally {
      unregisterSubagentsByPlugin("acme")
    }
  })

  it("unions built-ins with user templates", () => {
    const userTpl: SubAgentTemplate = {
      id: "user-disp-1",
      name: "Dispatch Helper",
      description: "helps",
      category: "coding",
      taskTemplate: "do {{x}}",
      config: { systemPrompt: "help." },
      isBuiltIn: false,
    }
    useSubagentRuntimeStore.getState().addTemplate(userTpl)
    try {
      const ids = resolveDispatchableSubagents().map((x) => x.id)
      expect(ids).toContain("workflow-designer")
      expect(ids).toContain("template:dispatch-helper")
    } finally {
      useSubagentRuntimeStore.getState().deleteTemplate("user-disp-1")
    }
  })

  it("carries a template's externalPresetId + mcpServerIds onto the dispatchable def (A2)", () => {
    const extTpl: SubAgentTemplate = {
      id: "user-disp-ext",
      name: "External Dispatcher",
      description: "dispatches externally",
      category: "coding",
      taskTemplate: "run {{x}}",
      config: {
        systemPrompt: "run.",
        externalPresetId: "claude-code",
        mcpServerIds: ["github"],
      },
      isBuiltIn: false,
    }
    useSubagentRuntimeStore.getState().addTemplate(extTpl)
    try {
      // This is the def `dispatch_agent` → runExternalSubagent actually runs, so
      // both fields must be present for external MCP forwarding to fire.
      const def = getDispatchableSubagentDef("template:external-dispatcher")
      expect(def?.externalPresetId).toBe("claude-code")
      expect(def?.mcpServerIds).toEqual(["github"])
    } finally {
      useSubagentRuntimeStore.getState().deleteTemplate("user-disp-ext")
    }
  })
})
