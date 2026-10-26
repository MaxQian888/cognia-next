import {
  __resetPluginPromptsForTesting,
  getPluginPromptEntry,
  isPluginPromptId,
  listPluginPromptEntries,
  onPluginPromptsChanged,
  parsePluginPromptId,
  PLUGIN_PROMPT_MAX_CHARS,
  pluginPromptDefinition,
  pluginPromptId,
  registerPluginPrompts,
  unregisterPluginPrompts,
} from "./plugin-prompts"
import { getPromptDefinition, listPromptDefinitions } from "./catalog"

const CONSUMER = "plugins/deep-research/src/engine/prompts.ts"

afterEach(() => __resetPluginPromptsForTesting())

describe("plugin prompt ids", () => {
  it("namespaces a local id under its plugin", () => {
    const id = pluginPromptId("cognia-deep-research", "decide-action")
    expect(id).toBe("plugin:cognia-deep-research/decide-action")
    expect(isPluginPromptId(id)).toBe(true)
    expect(parsePluginPromptId(id)).toEqual({
      pluginId: "cognia-deep-research",
      localId: "decide-action",
    })
  })

  it("rejects ids that are not well-formed plugin ids", () => {
    expect(isPluginPromptId("generation.title.chat")).toBe(false)
    expect(parsePluginPromptId("generation.title.chat")).toBeUndefined()
    expect(parsePluginPromptId("plugin:/x")).toBeUndefined()
    expect(parsePluginPromptId("plugin:p/../x")).toBeUndefined()
    expect(parsePluginPromptId("plugin:p")).toBeUndefined()
  })
})

describe("pluginPromptDefinition", () => {
  it("assigns the authority fields itself", () => {
    const def = pluginPromptDefinition(
      "p",
      {
        id: "outline",
        title: "Outline",
        defaultBody: "Plan a report on {{topic}}.",
        variables: [{ name: "topic", required: true, maxChars: 200 }],
        requiredFragments: ["report"],
        contractVersion: 3,
        outputContract: "JSON",
        group: "knowledge",
      },
      CONSUMER
    )
    expect(def).toMatchObject({
      id: "plugin:p/outline",
      contractVersion: 3,
      kind: "feature-template",
      group: "knowledge",
      operation: "replace-template",
      scopes: ["account", "workspace"],
      activation: "next-operation",
      risk: "ordinary",
      hosts: ["app"],
      maxChars: PLUGIN_PROMPT_MAX_CHARS,
      outputContract: "JSON",
      consumers: [CONSUMER],
    })
  })

  it("lets the host narrow scopes and caps the budget a plugin asks for", () => {
    const def = pluginPromptDefinition(
      "p",
      { id: "x", title: "X", defaultBody: "Body.", maxChars: 10 * PLUGIN_PROMPT_MAX_CHARS },
      CONSUMER,
      { scopes: ["account"] }
    )
    expect(def.scopes).toEqual(["account"])
    expect(def.maxChars).toBe(PLUGIN_PROMPT_MAX_CHARS)
  })

  it.each([
    ["an invalid id", { id: "a/b", title: "T", defaultBody: "Body." }, "invalid prompt id"],
    ["an empty title", { id: "a", title: " ", defaultBody: "Body." }, "needs a title"],
    [
      "a default over its budget",
      { id: "a", title: "T", defaultBody: "x".repeat(20), maxChars: 10 },
      "too-long",
    ],
    [
      "a default without its fragment",
      { id: "a", title: "T", defaultBody: "Body.", requiredFragments: ['"action"'] },
      "missing-fragment",
    ],
    [
      "an undeclared placeholder",
      { id: "a", title: "T", defaultBody: "Hi {{who}}." },
      "unknown-variable",
    ],
  ])("refuses %s", (_label, declaration, message) => {
    expect(() => pluginPromptDefinition("p", declaration, CONSUMER)).toThrow(message)
  })

  it("refuses an invalid plugin id", () => {
    expect(() =>
      pluginPromptDefinition("bad/id", { id: "a", title: "T", defaultBody: "Body." }, CONSUMER)
    ).toThrow("invalid plugin id")
  })
})

describe("registry", () => {
  it("registers entries the catalog serves and drops them with the disposer", () => {
    const listener = jest.fn()
    const off = onPluginPromptsChanged(listener)
    const dispose = registerPluginPrompts(
      "p",
      [{ id: "a", title: " Alpha ", description: " First ", defaultBody: "Alpha." }],
      CONSUMER
    )
    expect(listener).toHaveBeenCalledTimes(1)
    expect(getPluginPromptEntry("plugin:p/a")).toMatchObject({
      pluginId: "p",
      localId: "a",
      title: "Alpha",
      description: "First",
    })
    expect(getPromptDefinition("plugin:p/a")?.defaultBody).toBe("Alpha.")
    expect(listPromptDefinitions().at(-1)?.id).toBe("plugin:p/a")

    dispose()
    expect(getPromptDefinition("plugin:p/a")).toBeUndefined()
    expect(listener).toHaveBeenCalledTimes(2)
    dispose()
    expect(listener).toHaveBeenCalledTimes(2)
    off()
  })

  it("registers nothing when one declaration is invalid or duplicated", () => {
    expect(() =>
      registerPluginPrompts(
        "p",
        [
          { id: "a", title: "A", defaultBody: "A." },
          { id: "b", title: "B", defaultBody: "" },
        ],
        CONSUMER
      )
    ).toThrow("empty")
    expect(() =>
      registerPluginPrompts(
        "p",
        [
          { id: "a", title: "A", defaultBody: "A." },
          { id: "a", title: "A", defaultBody: "A." },
        ],
        CONSUMER
      )
    ).toThrow("duplicate")
    expect(listPluginPromptEntries()).toEqual([])
  })

  it("replaces an id on re-registration, and an old disposer leaves the new entry", () => {
    const first = registerPluginPrompts(
      "p",
      [{ id: "a", title: "A", defaultBody: "One." }],
      CONSUMER
    )
    registerPluginPrompts("p", [{ id: "a", title: "A", defaultBody: "Two." }], CONSUMER)
    first()
    expect(getPluginPromptEntry("plugin:p/a")?.def.defaultBody).toBe("Two.")
  })

  it("unregisters a plugin's prompts, or only those under a local prefix", () => {
    registerPluginPrompts(
      "p",
      [
        { id: "subagent.x", title: "X", defaultBody: "X." },
        { id: "outline", title: "Outline", defaultBody: "O." },
      ],
      CONSUMER
    )
    registerPluginPrompts("q", [{ id: "subagent.y", title: "Y", defaultBody: "Y." }], CONSUMER)
    unregisterPluginPrompts("p", "subagent.")
    expect(listPluginPromptEntries().map((entry) => entry.def.id)).toEqual([
      "plugin:p/outline",
      "plugin:q/subagent.y",
    ])
    unregisterPluginPrompts("p")
    expect(listPluginPromptEntries().map((entry) => entry.def.id)).toEqual(["plugin:q/subagent.y"])
  })
})
