/** @cognia-host-integration-test */
import type { PluginContext, PluginToolRegistration } from "@cognia/plugin-sdk"
import { createTestPluginContext } from "@cognia/plugin-sdk/testing"
import { createWorkflowAuthorAPI } from "@/lib/plugin/api/workflow-author-api"
import definition, { buildWorkflowAiTools, manifest } from "./index"
import manifestJson from "../plugin.json"
import { WORKFLOW_RUN_TIMEOUT_MS } from "./tools/run-tools"
import {
  WORKFLOW_RUNNER_TOOL_NAME,
  WORKFLOW_RUNNER_TOOL_DEFINITION,
} from "@cognia/plugin-sdk/api/workflow-run"
describe("buildWorkflowAiTools", () => {
  const tools = buildWorkflowAiTools(
    createWorkflowAuthorAPI() as PluginContext["workflow"],
    {} as PluginContext["resources"],
    (key) => key
  )
  const names = tools.map((t) => t.name)

  it("composes every tool family, including the wake tool", () => {
    // One representative per build* family — a dropped spread fails here.
    for (const expected of [
      "wf_read_graph",
      "wf_add_node",
      "wf_list_workflows",
      WORKFLOW_RUNNER_TOOL_NAME,
      "wf_emit_workflow_event",
    ]) {
      expect(names).toContain(expected)
    }
  })

  it("has no duplicate tool names", () => {
    expect(new Set(names).size).toBe(names.length)
  })

  it("registers the typed runner from the SHARED definition, plus a run-length budget", () => {
    const runner = tools.find((t) => t.name === WORKFLOW_RUNNER_TOOL_NAME)
    expect(runner?.definition).toEqual({
      ...WORKFLOW_RUNNER_TOOL_DEFINITION,
      timeoutMs: WORKFLOW_RUN_TIMEOUT_MS,
    })
  })

  it("leaves ownership to the host: no tool claims a pluginId", () => {
    expect(tools).toHaveLength(37)
    for (const tool of tools) expect(Object.hasOwn(tool, "pluginId")).toBe(false)
  })

  it("budgets every tool that waits for a whole run past the 30 s default", () => {
    for (const name of ["wf_run_workflow", "wf_run_from_step", WORKFLOW_RUNNER_TOOL_NAME]) {
      expect(tools.find((t) => t.name === name)?.definition.timeoutMs).toBe(WORKFLOW_RUN_TIMEOUT_MS)
    }
  })
})

describe("workflow-ai manifest + activation", () => {
  it("spreads plugin.json and declares no commands capability it does not use", () => {
    expect(manifest).toBe(manifestJson)
    expect(manifest.capabilities).toEqual(["tools"])
    expect(manifestJson).not.toHaveProperty("commands")
  })

  it("justifies every permission, including database:read for the resource tools", () => {
    expect(manifest.permissions).toContain("database:read")
    for (const permission of manifest.permissions ?? []) {
      expect(manifestJson.permissionJustifications[permission as never]).toBeTruthy()
    }
  })

  it("registers every tool through ctx.agent and releases the workflow API on dispose", async () => {
    const registered: PluginToolRegistration[] = []
    const { ctx, dispose } = createTestPluginContext({
      pluginId: "cognia-workflow-ai",
      overrides: {
        agent: { registerTool: (tool: PluginToolRegistration) => void registered.push(tool) },
        workflow: createWorkflowAuthorAPI(),
      },
    })
    await definition.activate(ctx)
    expect(registered).toHaveLength(37)
    await dispose()
    const { getWorkflowApi } = await import("./store-bridge")
    expect(() => getWorkflowApi()).toThrow(/inactive/)
    expect(definition.deactivate).toBeUndefined()
  })
})
