/**
 * Workflow Copilot prompt + allow/disallow constants — surface tests.
 *
 * The point of these tests is NOT to pin the prose verbatim — prompts will
 * drift as we tune the agent. Instead we lock down the *contracts* the
 * rest of the code relies on:
 *   • the allowed list contains every `wf_*` tool the plugin ships
 *   • the allowed list contains `Read` (so the templates dir is reachable)
 *   • the disallowed list blocks Bash / Write / Edit / Computer Use
 *   • the prompt builder includes the per-turn snapshot when supplied
 *   • the prompt mentions every slash command + the mention syntax
 *     (so a downstream lint / doc check could verify they stay in sync)
 */

import {
  WORKFLOW_COPILOT_ALLOWED_TOOLS,
  WORKFLOW_COPILOT_DISALLOWED_TOOLS,
  WORKFLOW_COPILOT_SUBAGENT_NAMES,
  buildWorkflowCopilotPrompt,
  workflowCopilotAgent,
} from "./workflow-copilot-prompt"

describe("WORKFLOW_COPILOT_ALLOWED_TOOLS", () => {
  it("contains every wf_* tool family the plugin currently ships", () => {
    const expected = [
      "wf_read_graph",
      "wf_read_selection",
      "wf_read_node",
      "wf_get_validation_errors",
      "wf_get_last_run",
      "wf_add_node",
      "wf_remove_node",
      "wf_connect_edge",
      "wf_disconnect_edge",
      "wf_configure_node",
      "wf_propose_batch",
      "wf_batch_apply",
      "wf_list_templates",
      "wf_apply_template",
      "wf_auto_layout",
      "wf_group_nodes",
      "wf_select_nodes",
      "wf_focus_viewport",
      "wf_run_workflow",
      "wf_run_from_step",
      "wf_cancel_run",
    ]
    for (const name of expected) {
      expect(WORKFLOW_COPILOT_ALLOWED_TOOLS).toContain(`mcp__cognia-plugin-tools__${name}`)
    }
  })

  it("contains the Read built-in so the templates dir is reachable", () => {
    expect(WORKFLOW_COPILOT_ALLOWED_TOOLS).toContain("Read")
  })

  it("does NOT include Bash, Write, or Edit", () => {
    for (const banned of ["Bash", "Write", "Edit"]) {
      expect(WORKFLOW_COPILOT_ALLOWED_TOOLS).not.toContain(banned)
    }
  })
})

describe("WORKFLOW_COPILOT_DISALLOWED_TOOLS", () => {
  it("blocks the high-impact built-ins", () => {
    for (const banned of ["Bash", "Write", "Edit", "WebFetch", "WebSearch"]) {
      expect(WORKFLOW_COPILOT_DISALLOWED_TOOLS).toContain(banned)
    }
  })

  it("blocks the Computer Use tool family", () => {
    for (const banned of ["computer", "bash", "str_replace_editor"]) {
      expect(WORKFLOW_COPILOT_DISALLOWED_TOOLS).toContain(banned)
    }
  })
})

describe("buildWorkflowCopilotPrompt", () => {
  it("returns a non-empty string with no trailing whitespace", () => {
    const prompt = buildWorkflowCopilotPrompt(null)
    expect(prompt.length).toBeGreaterThan(200)
    expect(prompt).toBe(prompt.trim())
  })

  it("includes every slash command name", () => {
    const prompt = buildWorkflowCopilotPrompt(null)
    for (const slash of ["/validate", "/explain", "/suggest", "/run", "/debug", "/refactor"]) {
      expect(prompt).toContain(slash)
    }
  })

  it("documents the @-mention syntax for nodes and edges", () => {
    const prompt = buildWorkflowCopilotPrompt(null)
    expect(prompt).toContain("@node:")
    expect(prompt).toContain("@edge:")
  })

  it("names every subagent for delegation", () => {
    const prompt = buildWorkflowCopilotPrompt(null)
    for (const name of WORKFLOW_COPILOT_SUBAGENT_NAMES) {
      expect(prompt).toContain(name)
    }
  })

  it("appends the per-turn snapshot block when supplied", () => {
    const snapshot = "# Currently-open workflow\n- workflowId: wf_42\n- nodes: 3"
    const prompt = buildWorkflowCopilotPrompt(snapshot)
    expect(prompt).toContain(snapshot)
    // The snapshot should land at the very end (after "---" separator).
    expect(prompt.endsWith(snapshot)).toBe(true)
  })

  it("omits the snapshot section cleanly when null", () => {
    const prompt = buildWorkflowCopilotPrompt(null)
    expect(prompt).not.toContain("Currently-open workflow")
  })

  it("nudges propose-batch for multi-op plans", () => {
    const prompt = buildWorkflowCopilotPrompt(null)
    expect(prompt).toContain("wf_propose_batch")
  })
})

describe("workflowCopilotAgent definition", () => {
  it("is a valid AgentDefinition shape for Task-tool spawning", () => {
    expect(workflowCopilotAgent.description.length).toBeGreaterThan(20)
    expect(workflowCopilotAgent.prompt.length).toBeGreaterThan(200)
    expect((workflowCopilotAgent.tools ?? []).length).toBe(WORKFLOW_COPILOT_ALLOWED_TOOLS.length)
  })
})
