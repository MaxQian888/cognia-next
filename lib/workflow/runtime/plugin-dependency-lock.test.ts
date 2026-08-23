import type { PluginRow } from "@/lib/db/plugin-types"
import type { WorkflowExecutionBinding } from "@/types/workflow/deployment"
import { workflowVersionDigest } from "@/lib/workflow/versioning/version-snapshot"
import {
  assertWorkflowPluginDependencyLock,
  WorkflowPluginLockError,
} from "./plugin-dependency-lock"

const manifest = { id: "demo.plugin", version: "1.0.0", capabilities: ["tools"] }
const plugin: PluginRow = {
  id: "demo.plugin",
  name: "Demo",
  version: "1.0.0",
  status: "enabled",
  source: "builtin",
  type: "frontend",
  enabled: true,
  capabilities: ["tools"],
  path: "builtin://demo.plugin",
  manifest,
  createdAt: 1,
  updatedAt: 1,
}

function binding(
  pluginPatch: Partial<
    NonNullable<NonNullable<WorkflowExecutionBinding["dependencyLock"]>["plugins"]>[string]
  > = {}
): WorkflowExecutionBinding {
  return {
    versionId: "version-1",
    deploymentId: "deployment-1",
    deploymentRevision: 1,
    entrypoint: "portal",
    caller: "portal",
    dependencyLock: {
      workflows: {},
      indexes: {},
      plugins: {
        "demo.plugin": {
          pluginId: "demo.plugin",
          version: "1.0.0",
          manifestDigest: workflowVersionDigest(manifest),
          capabilities: ["tools"],
          runtimeProfile: "headless",
          ...pluginPatch,
        },
      },
    },
  }
}

describe("assertWorkflowPluginDependencyLock", () => {
  it("accepts the exact frozen plugin and legacy unlocked runs", () => {
    expect(() => assertWorkflowPluginDependencyLock(binding(), plugin)).not.toThrow()
    expect(() => assertWorkflowPluginDependencyLock(undefined, plugin)).not.toThrow()
    expect(() =>
      assertWorkflowPluginDependencyLock(
        { ...binding(), dependencyLock: { workflows: {}, indexes: {} } },
        plugin
      )
    ).not.toThrow()
  })

  it("rejects missing, version-drifted, and manifest-drifted plugins", () => {
    expect(() =>
      assertWorkflowPluginDependencyLock(
        { ...binding(), dependencyLock: { workflows: {}, indexes: {}, plugins: {} } },
        plugin
      )
    ).toThrow(expect.objectContaining({ code: "plugin-not-locked" }))
    expect(() => assertWorkflowPluginDependencyLock(binding({ version: "2.0.0" }), plugin)).toThrow(
      expect.objectContaining({ code: "plugin-version-drift" })
    )
    expect(() =>
      assertWorkflowPluginDependencyLock(binding({ manifestDigest: "wfv1:drift" }), plugin)
    ).toThrow(expect.objectContaining({ code: "plugin-manifest-drift" }))
  })

  it("uses a non-retryable typed error", () => {
    try {
      assertWorkflowPluginDependencyLock(binding({ version: "2.0.0" }), plugin)
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowPluginLockError)
      expect(error).toMatchObject({ retryable: false })
    }
  })
})
