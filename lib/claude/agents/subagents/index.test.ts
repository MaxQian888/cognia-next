import { resolveAllSubagents, getDispatchableSubagentDef } from "./index"
import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"
import {
  registerSubagent,
  unregisterSubagentsByPlugin,
} from "@/lib/plugin/registries/subagent-registry"

describe("portable subagent context policy projections", () => {
  it("preserves portable context policy for native and dispatch projections", () => {
    useSubagentRuntimeStore.getState().addTemplate({
      id: "compact-policy",
      name: "Compact policy",
      description: "reviews",
      category: "coding",
      taskTemplate: "review",
      config: { contextPolicy: { compactAtTokens: 64000 } },
    })
    try {
      expect(
        resolveAllSubagents({ context: "direct" })["template:compact-policy"].contextPolicy
      ).toEqual({ compactAtTokens: 64000 })
      expect(getDispatchableSubagentDef("template:compact-policy")?.contextPolicy).toEqual({
        compactAtTokens: 64000,
      })
    } finally {
      useSubagentRuntimeStore.getState().deleteTemplate("compact-policy")
    }
  })

  it("retains plugin context policy on the native surface without aliasing the manifest", () => {
    const policy = { compactAtTokens: 64000 }
    registerSubagent(
      "compact",
      {
        id: "compact",
        name: "Compact",
        description: "review",
        prompt: "review",
        contextPolicy: policy,
      },
      { pluginId: "context-policy-test" }
    )
    try {
      const def = resolveAllSubagents({ context: "direct" })["context-policy-test:compact"]
      expect(def.contextPolicy).toEqual(policy)
      expect(def.contextPolicy).not.toBe(policy)
    } finally {
      unregisterSubagentsByPlugin("context-policy-test")
    }
  })

  it("rejects an invalid threshold restored from storage before native projection", () => {
    useSubagentRuntimeStore.setState((s) => ({
      templates: {
        ...s.templates,
        "invalid-context-policy": {
          id: "invalid-context-policy",
          name: "Invalid policy",
          description: "review",
          category: "coding",
          taskTemplate: "review",
          config: { contextPolicy: { compactAtTokens: 1.5 } },
        },
      },
    }))
    try {
      expect(() => resolveAllSubagents({ context: "direct" })).toThrow(/positive safe integer/)
    } finally {
      useSubagentRuntimeStore.getState().deleteTemplate("invalid-context-policy")
    }
  })
})
