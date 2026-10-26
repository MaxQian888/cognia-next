import { resolveAllSubagents, getDispatchableSubagentDef } from "./index"
import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"
import {
  registerSubagent,
  unregisterSubagentsByPlugin,
} from "@/lib/plugin/registries/subagent-registry"
import { getPluginPromptEntry } from "@/lib/prompts/plugin-prompts"
import { registerPluginSubagentPrompt } from "@/lib/prompts/plugin-subagent-prompts"
import {
  __setPromptOverrideSnapshotForTests,
  buildPromptOverrideSnapshot,
} from "@/lib/prompts/snapshot"

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

describe("plugin subagent prompt overrides", () => {
  it("sends an account override on both rails and keeps every other field", () => {
    const def = {
      id: "researcher",
      name: "Researcher",
      description: "Finds sources",
      prompt: "Research the question.",
      effort: "high" as const,
      disallowedTools: ["Bash"],
    }
    registerSubagent("researcher", def, { pluginId: "override-test" })
    const dispose = registerPluginSubagentPrompt("override-test", def)
    const slot = getPluginPromptEntry("plugin:override-test/subagent.researcher")!.def
    __setPromptOverrideSnapshotForTests(
      buildPromptOverrideSnapshot("test-db", [
        {
          bindingId: "pob-1",
          promptId: slot.id,
          scope: "account",
          targetId: "",
          revisionId: "por-1",
          body: "Research with primary sources only.",
          contractVersion: slot.contractVersion,
        },
      ])
    )
    try {
      expect(resolveAllSubagents({ context: "team" })["override-test:researcher"]).toMatchObject({
        prompt: "Research with primary sources only.",
        effort: "high",
        disallowedTools: ["Bash"],
      })
      expect(getDispatchableSubagentDef("override-test:researcher")).toMatchObject({
        prompt: "Research with primary sources only.",
        effort: "high",
        disallowedTools: ["Bash"],
      })
    } finally {
      __setPromptOverrideSnapshotForTests(null)
      dispose()
      unregisterSubagentsByPlugin("override-test")
    }
  })
})

describe("template dispatch model selection", () => {
  it.each([true, false])(
    "preserves provider and scopes gateway fields to external templates (%s)",
    (external) => {
      const modelRoles = {
        version: 1 as const,
        slots: { "subagent.default": { kind: "inherit-primary" as const } },
      }
      useSubagentRuntimeStore.getState().addTemplate({
        id: "model-routing",
        name: "Model routing",
        description: "route",
        category: "coding",
        taskTemplate: "go",
        config: {
          provider: "openai",
          model: "primary",
          cogniaModel: { providerId: "p", modelId: "m" },
          modelRoles,
          ...(external ? { externalPresetId: "codex" } : {}),
        },
      })
      try {
        const def = getDispatchableSubagentDef("template:model-routing")!
        expect(def.provider).toBe("openai")
        if (external) {
          expect(def.cogniaModel).toEqual({ providerId: "p", modelId: "m" })
          expect(def.modelRoles).toEqual(modelRoles)
        } else {
          expect(def).not.toHaveProperty("cogniaModel")
          expect(def).not.toHaveProperty("modelRoles")
        }
        expect(resolveAllSubagents({ context: "direct" })).not.toHaveProperty(
          "template:model-routing"
        )
      } finally {
        useSubagentRuntimeStore.getState().deleteTemplate("model-routing")
      }
    }
  )
})

it("carries external template roles when its pinned configuration supplies the primary binding", () => {
  const modelRoles = {
    version: 1 as const,
    slots: { "subagent.default": { kind: "inherit-primary" as const } },
  }
  useSubagentRuntimeStore.getState().addTemplate({
    id: "pinned-models",
    name: "Pinned models",
    description: "route",
    category: "coding",
    taskTemplate: "go",
    config: { externalPresetId: "codex", externalAgentConfigId: "pinned", modelRoles },
  })
  try {
    expect(getDispatchableSubagentDef("template:pinned-models")).toMatchObject({
      externalPresetId: "codex",
      externalAgentConfigId: "pinned",
      modelRoles,
    })
  } finally {
    useSubagentRuntimeStore.getState().deleteTemplate("pinned-models")
  }
})
