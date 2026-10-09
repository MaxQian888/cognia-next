/**
 * @jest-environment jsdom
 *
 * The agent form (ADR-0220): hydration from `initial`, the payload `onSave`
 * receives, the controlled mode the builder's draft panel drives, and the
 * default-runtime field. The pure projections are tested in
 * `lib/agents/editor-state.test.ts` and
 * `lib/plugin/character-pack/editor-projection.test.ts`.
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/components/settings/character/twin-binding-section", () => ({
  TwinBindingSection: () => null,
}))

// The real field reads the runtime catalog stores; a stub that picks one lane
// is enough to prove the editor carries the value through.
jest.mock("@/components/agents/editor/agent-runtime-field", () => ({
  AgentRuntimeField: ({
    value,
    onChange,
  }: {
    value: { kind: string; agentId?: string } | undefined
    onChange: (next: unknown) => void
  }) => (
    <div>
      <span data-testid="runtime-value">
        {value ? `${value.kind}:${value.agentId ?? ""}` : "default"}
      </span>
      <button
        type="button"
        onClick={() => onChange({ kind: "external", agentId: "codex", name: "Codex" })}
      >
        pick-codex
      </button>
      <button type="button" onClick={() => onChange(undefined)}>
        pick-default
      </button>
    </div>
  ),
}))

jest.mock("@/components/settings/speech/test-tts-button", () => ({
  TestTtsButton: () => null,
}))

jest.mock("@/lib/plugin/registries/native-anthropic-tool-registry", () => ({
  listNativeAnthropicToolEntries: () => [],
  listNativeAnthropicToolIds: () => [],
}))

jest.mock("@/lib/subscription/core/transport", () => ({
  listAccounts: jest.fn(async () => []),
  listSubscriptionProviderIds: jest.fn(async () => [
    "anthropic",
    "codex",
    "opencode",
    "commandcode",
    "custom-service",
  ]),
}))

let mockSubscriptionAccounts: Record<
  string,
  { accounts: Array<{ id: string; label?: string; email?: string }> }
> = {}
jest.mock("@/lib/subscription/core/hooks", () => ({
  useSubscriptionAccounts: () => ({ byProvider: mockSubscriptionAccounts, providers: [] }),
}))

const mockSaveAgentEnvSecret = jest.fn(async (..._args: unknown[]) => undefined)
jest.mock("@/lib/agent/agent-env-keyring", () => ({
  createAgentEnvSecretRef: (agentId: string, name: string) => `${agentId}:${name}:new`,
  saveAgentEnvSecret: (...args: unknown[]) => mockSaveAgentEnvSecret(...args),
}))

// `mock`-prefixed names are the only out-of-scope refs jest allows inside a
// hoisted factory.
const mockToastError = jest.fn()
const mockToastSuccess = jest.fn()

// The sandbox hook's live query is replaced by a fixed list, which also lets
// the cua-desktop tier tests exercise a bound desktop.
jest.mock("@/hooks/automation/use-sandbox-connections", () => ({
  useSandboxConnections: () => ({
    connections: [{ id: "connection-1", name: "docker desktop" }],
    create: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
    provision: jest.fn(),
    start: jest.fn(),
    suspend: jest.fn(),
    resume: jest.fn(),
    stop: jest.fn(),
    refreshHealth: jest.fn(),
  }),
}))

jest.mock("sonner", () => ({
  toast: {
    error: (...a: unknown[]) => mockToastError(...a),
    success: (...a: unknown[]) => mockToastSuccess(...a),
    warning: jest.fn(),
  },
}))

// Only consulted once a tool-filter override is opened in the advanced area.
jest.mock("@/lib/tools/tool-catalog", () => ({
  getToolCatalog: jest.fn(async () => []),
  searchToolCatalog: (entries: unknown[]) => entries,
}))

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { CharacterEditor, type EditorState } from "./character-editor"
import type { Character } from "@cognia/agent-config-types"
import { __resetSkillsForTesting } from "@/lib/plugin/registries/skill-registry"
import {
  AGENT_OVERRIDE_FIELDS,
  emptyAgentOverrides,
  pickAgentOverrides,
} from "@/lib/agents/agent-overrides"
import { characterToEditorState, emptyEditorState } from "@/lib/agents/editor-state"

afterEach(() => {
  __resetSkillsForTesting()
  mockSaveAgentEnvSecret.mockClear()
  mockSubscriptionAccounts = {}
  mockToastError.mockClear()
})

// Narrow view of the EditorOutput payload the assertions read.
type SavePayload = {
  model?: string
  modelRouting?: Character["modelRouting"]
  executionPolicy?: Character["executionPolicy"]
  persona?: unknown
  voiceProfile?: unknown
  avatarImage?: { webDataUrl?: string }
  availableOnPlatforms?: unknown
  knowledgeBaseIds?: string[]
  pluginSkillIds?: string[]
  memoryPolicy?: Character["memoryPolicy"]
}

function baseInitial(overrides: Partial<EditorState> = {}): EditorState {
  return {
    name: "Tutor",
    description: "",
    avatarColor: "oklch(0.7 0 0)",
    avatarEmoji: "🐙",
    systemPrompt: "You are a tutor.",
    model: "",
    planModel: "",
    utilityModel: "",
    executionEffort: "inherit",
    executionMaxTurns: "",
    executionEnvBindings: undefined,
    computerUseTarget: "local",
    permissionMode: undefined,
    allowedTools: [],
    disallowedTools: [],
    mcpServerIds: undefined,
    skillIds: [],
    pluginSkillIds: [],
    knowledgeBaseIds: [],
    memoryRecall: true,
    memoryCreate: true,
    memoryUpdate: true,
    memoryForget: true,
    memoryAutoLearn: true,
    memoryReadableScopes: ["global", "workspace", "character", "agent"],
    memoryWritableScopes: ["global", "workspace", "character", "agent"],
    workingDir: "",
    bareMode: false,
    debugMode: false,
    briefMode: false,
    twinId: undefined,
    twinSettings: undefined,
    enableComputerUse: false,
    enableBrowserTools: false,
    computerUseSettings: undefined,
    sandboxEnabled: false,
    sandboxTier: "inherit",
    accountIdOverride: "inherit",
    runtime: undefined,
    personaTone: "",
    personaPersonality: "",
    openingMessage: "",
    exemplarPromptsText: "",
    avatarImageDataUrl: "",
    voiceProvider: "none",
    voiceId: "",
    voiceRate: 1,
    voicePitch: 1,
    voiceVolume: 1,
    availablePlatforms: [],
    overrides: emptyAgentOverrides(),
    ...overrides,
  }
}

function renderEditor(
  initial: EditorState,
  knowledgeBaseCatalog: Array<{
    id: string
    name: string
    description?: string
    createdAt: number
    updatedAt: number
  }> = []
) {
  const onSave = jest.fn(async (_data: SavePayload) => undefined)
  render(
    <CharacterEditor
      initial={initial}
      skillsCatalog={[]}
      mcpCatalog={[]}
      knowledgeBaseCatalog={knowledgeBaseCatalog}
      submitLabel="Save"
      onCancel={() => undefined}
      onSave={onSave}
    />
  )
  return { onSave }
}

describe("CharacterEditor — v2 fields", () => {
  it("keeps the cua-desktop tier visible but disabled while nothing is bound", async () => {
    // The tier runs shell and file work inside the bound desktop, so without
    // one it can only ever be refused at send time. Disabled and explained
    // rather than hidden, so the requirement is discoverable.
    renderEditor(baseInitial({ sandboxTier: "cua-desktop", computerUseTarget: "local" }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByText("tier.cuaDesktopNeedsBoundDesktop")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("character-sandbox-tier"))
    expect(screen.getByRole("option", { name: "tier.cuaDesktop" })).toHaveAttribute(
      "aria-disabled",
      "true"
    )
  })

  it("offers the cua-desktop tier once a desktop is bound", async () => {
    // `docker exec` carries shell and file work into the container, so the
    // tier is selectable. Leaving it permanently disabled would ship the whole
    // path unreachable.
    renderEditor(
      baseInitial({
        sandboxTier: "cua-desktop",
        enableComputerUse: true,
        computerUseTarget: "connection-1",
      })
    )
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.queryByText("tier.cuaDesktopNeedsBoundDesktop")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("character-sandbox-tier"))
    expect(screen.getByRole("option", { name: "tier.cuaDesktop" })).not.toHaveAttribute(
      "aria-disabled",
      "true"
    )
  })

  it("hydrates persona, voice, avatar image, and platform fields from initial and saves them", async () => {
    const { onSave } = renderEditor(
      baseInitial({
        personaTone: "warm",
        personaPersonality: "Patient teacher",
        openingMessage: "Hi there!",
        exemplarPromptsText: "Explain X\nDraft Y",
        avatarImageDataUrl: "data:image/png;base64,AAAA",
        voiceProvider: "openai",
        voiceId: "alloy",
        availablePlatforms: ["tauri"],
      })
    )

    // Persona inputs hydrate.
    expect(screen.getByDisplayValue("warm")).toBeInTheDocument()
    expect(screen.getByDisplayValue("Patient teacher")).toBeInTheDocument()
    expect(screen.getByDisplayValue("Hi there!")).toBeInTheDocument()
    // Avatar image renders.
    expect(document.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AAAA")

    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    const payload = onSave.mock.calls[0][0]
    expect(payload.persona).toEqual({
      tone: "warm",
      personality: "Patient teacher",
      openingMessage: "Hi there!",
      exemplarPrompts: ["Explain X", "Draft Y"],
    })
    expect(payload.voiceProfile).toEqual({
      provider: "openai",
      voiceId: "alloy",
      rate: 1,
      pitch: 1,
      volume: 1,
    })
    expect(payload.avatarImage).toEqual({ webDataUrl: "data:image/png;base64,AAAA" })
    expect(payload.availableOnPlatforms).toEqual(["tauri"])
  })

  it("omits the v2 fields when blank (no persona / voice / image / platform restriction)", async () => {
    const { onSave } = renderEditor(baseInitial())
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    const payload = onSave.mock.calls[0][0]
    expect(payload.persona).toBeUndefined()
    expect(payload.voiceProfile).toBeUndefined()
    expect(payload.avatarImage).toBeUndefined()
    expect(payload.availableOnPlatforms).toBeUndefined()
  })

  it("toggles a platform restriction via the badge", async () => {
    const { onSave } = renderEditor(baseInitial())
    fireEvent.click(screen.getByText("platforms.tauri"))
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave.mock.calls[0][0].availableOnPlatforms).toEqual(["tauri"])
  })

  it("can restrict a character to the mobile platform", async () => {
    const { onSave } = renderEditor(baseInitial())
    fireEvent.click(screen.getByText("platforms.mobile"))
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave.mock.calls[0][0].availableOnPlatforms).toEqual(["mobile"])
  })

  it("clears the avatar image via the remove button", async () => {
    const { onSave } = renderEditor(
      baseInitial({ avatarImageDataUrl: "data:image/png;base64,AAAA" })
    )
    expect(document.querySelector("img")).not.toBeNull()
    fireEvent.click(screen.getByText("avatarImage.clear"))
    expect(document.querySelector("img")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave.mock.calls[0][0].avatarImage).toBeUndefined()
  })

  it("reads an uploaded image file into a data URL", async () => {
    const { onSave } = renderEditor(baseInitial())
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(["binary"], "avatar.png", { type: "image/png" })
    fireEvent.change(fileInput, { target: { files: [file] } })
    // FileReader.readAsDataURL is async — wait for the avatar img to appear.
    await waitFor(() =>
      expect(document.querySelector("img")?.getAttribute("src")).toMatch(/^data:/)
    )
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave.mock.calls[0][0].avatarImage?.webDataUrl).toMatch(/^data:/)
  })
})

describe("CharacterEditor — Agent profile", () => {
  it("persists Agent memory operations, scopes, and automatic learning", async () => {
    const { onSave } = renderEditor(baseInitial())

    fireEvent.click(screen.getByRole("switch", { name: "operations.recall" }))
    fireEvent.click(screen.getByRole("switch", { name: "operations.autoLearn" }))
    fireEvent.click(screen.getByRole("checkbox", { name: "readableScopes: scopes.global" }))
    fireEvent.click(screen.getByRole("checkbox", { name: "writableScopes: scopes.workspace" }))
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave.mock.calls[0][0].memoryPolicy).toEqual({
      operations: {
        recall: false,
        create: true,
        update: true,
        forget: true,
      },
      readableScopes: ["workspace", "character", "agent"],
      writableScopes: ["global", "character", "agent"],
      autoLearn: false,
    })
  })

  it("binds multiple reusable Knowledge Bases to the Agent", async () => {
    const { onSave } = renderEditor(baseInitial(), [
      { id: "kb-product", name: "Product docs", createdAt: 1, updatedAt: 1 },
      { id: "kb-support", name: "Support notes", createdAt: 1, updatedAt: 1 },
    ])

    fireEvent.click(screen.getByRole("button", { name: "Product docs" }))
    fireEvent.click(screen.getByRole("button", { name: "Support notes" }))
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave.mock.calls[0][0].knowledgeBaseIds).toEqual(["kb-product", "kb-support"])
  })

  it("attaches a plugin skill and keeps ids of plugins that are currently off", async () => {
    const { registerSkill, unregisterSkillsByPlugin } = jest.requireActual<
      typeof import("@/lib/plugin/registries/skill-registry")
    >("@/lib/plugin/registries/skill-registry")
    registerSkill(
      "acme:review",
      {
        id: "acme:review",
        name: "Acme review",
        description: "Reviews a diff",
        source: { kind: "inline", markdown: "# review" },
      },
      { pluginId: "acme" }
    )
    try {
      const { onSave } = renderEditor(baseInitial({ pluginSkillIds: ["offline:skill"] }))
      fireEvent.click(screen.getByRole("button", { name: "Acme review" }))
      fireEvent.click(screen.getByRole("button", { name: "Save" }))

      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
      expect(onSave.mock.calls[0][0].pluginSkillIds).toEqual(["offline:skill", "acme:review"])
    } finally {
      unregisterSkillsByPlugin("acme")
    }
  })

  it("saves semantic model targets and Agent execution defaults", async () => {
    const { onSave } = renderEditor(
      baseInitial({
        planModel: "planner-alias",
        model: "executor-alias",
        utilityModel: "fast-alias",
        executionEffort: "high",
        executionMaxTurns: "24",
      })
    )

    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        model: "executor-alias",
        modelRouting: {
          plan: "planner-alias",
          execute: "executor-alias",
          utility: "fast-alias",
        },
        executionPolicy: { effort: "high", maxTurns: 24, envBindings: undefined },
      })
    )
  })

  it("preserves existing secure environment references when editing other defaults", async () => {
    const envBindings = [{ name: "TOKEN", kind: "secret" as const, secretRef: "agent-1:TOKEN" }]
    const { onSave } = renderEditor(
      baseInitial({ executionMaxTurns: "8", executionEnvBindings: envBindings })
    )

    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave.mock.calls[0][0].executionPolicy).toEqual({
      effort: undefined,
      maxTurns: 8,
      envBindings,
    })
  })

  it("saves plain environment bindings with the Agent profile", async () => {
    const { onSave } = renderEditor(baseInitial({ executionMaxTurns: "8" }))

    fireEvent.click(screen.getByRole("button", { name: "execution.addEnv" }))
    fireEvent.change(screen.getByLabelText("execution.envName"), {
      target: { value: "API_BASE_URL" },
    })
    fireEvent.change(screen.getByLabelText("execution.envValue"), {
      target: { value: "https://example.test" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave.mock.calls[0][0].executionPolicy?.envBindings).toEqual([
      { name: "API_BASE_URL", kind: "plain", value: "https://example.test" },
    ])
    expect(mockSaveAgentEnvSecret).not.toHaveBeenCalled()
  })

  it("updates a secure environment value in the keyring without persisting the value", async () => {
    const envBindings = [{ name: "TOKEN", kind: "secret" as const, secretRef: "agent-1:TOKEN" }]
    const { onSave } = renderEditor(baseInitial({ executionEnvBindings: envBindings }))

    fireEvent.change(screen.getByLabelText("execution.envValue"), {
      target: { value: "super-secret" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(mockSaveAgentEnvSecret).toHaveBeenCalledWith("agent-1:TOKEN", "super-secret")
    expect(onSave.mock.calls[0][0].executionPolicy?.envBindings).toEqual(envBindings)
    expect(JSON.stringify(onSave.mock.calls[0][0])).not.toContain("super-secret")
  })

  it("rejects a max-turn value outside the runtime range", async () => {
    const { onSave } = renderEditor(baseInitial({ executionMaxTurns: "101" }))

    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(onSave).not.toHaveBeenCalled())
  })
})

it("includes registry-backed accounts in the character subscription picker", async () => {
  mockSubscriptionAccounts = {
    "custom-service": { accounts: [{ id: "cc-character", label: "Custom work" }] },
  }
  renderEditor(baseInitial())
  fireEvent.click(screen.getByTestId("character-account-override"))
  expect(await screen.findByRole("option", { name: "optionLabel" })).toBeInTheDocument()
})

describe("CharacterEditor — advanced overrides", () => {
  // One value for every override the editor owns, each deliberately NOT the
  // default a control would seed, so a round trip that normalised anything
  // would show up as a diff.
  const everyOverride = {
    providerId: "openrouter",
    sandboxPolicy: { maxCpuSeconds: 30, network: "allowlist", networkAllowlist: ["api.test"] },
    toolFilter: { mode: "deny", tools: ["Bash"], mcpServerIds: ["github"] },
    toolSearchRuntimeOverride: { enabled: false, alwaysLoadTools: ["read_file"] },
    compactionOverride: { compressionEnabled: false, tokenThreshold: 70 },
    instructionsOverride: { enabled: true, mode: "nearest", fileNames: ["RULES.md"] },
    outputStyle: "some-pack-style",
    customOutputStyle: "  Keep it short.  ",
    maxThinkingTokens: 0,
    a2uiEnabled: false,
    // A pack catalog that is not registered here must still round-trip.
    a2uiCatalogId: "pack-financial-catalog",
    enableOcr: false,
    enableBuiltInSkills: true,
    disablePluginTools: false,
    workspaceConfinementEnabled: false,
    platformDefaults: { mode: "draft", trigger: { storeUnmatchedInDraftMode: true } },
  } satisfies Partial<Character>

  const agent = (extra: Partial<Character> = {}): Character => ({
    id: "char_full",
    name: "Full",
    systemPrompt: "x",
    avatarColor: "#abc",
    createdAt: 0,
    updatedAt: 0,
    ...extra,
  })

  it("covers every override field in the round-trip fixture", () => {
    expect(Object.keys(everyOverride).sort()).toEqual([...AGENT_OVERRIDE_FIELDS].sort())
  })

  it("loads an agent with every override set and saves each one back identical", async () => {
    const { onSave } = renderEditor(characterToEditorState(agent(everyOverride)))
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    const patch = onSave.mock.calls[0]![0] as Partial<Character>
    for (const field of AGENT_OVERRIDE_FIELDS) {
      // Same reference, not merely equal: nothing was rebuilt on the way through.
      expect(patch[field]).toBe(everyOverride[field])
    }
  })

  it("round-trips them unchanged even with every override control mounted", async () => {
    const user = userEvent.setup()
    const { onSave } = renderEditor(characterToEditorState(agent(everyOverride)))
    await user.click(screen.getByTestId("agent-advanced-overrides"))
    expect(screen.getByTestId("agent-override-tool-filter")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    const patch = onSave.mock.calls[0]![0] as Partial<Character>
    for (const field of AGENT_OVERRIDE_FIELDS) expect(patch[field]).toBe(everyOverride[field])
  })

  it("saves none of them for an agent that sets none", async () => {
    const { onSave } = renderEditor(characterToEditorState(agent()))
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    const patch = onSave.mock.calls[0]![0] as Partial<Character>
    expect(pickAgentOverrides(patch)).toEqual(emptyAgentOverrides())
  })

  it("creates a new agent without inventing any override", async () => {
    const { onSave } = renderEditor(emptyEditorState())
    fireEvent.change(screen.getByPlaceholderText("namePlaceholder"), {
      target: { value: "New" },
    })
    fireEvent.change(screen.getByPlaceholderText("systemPromptPlaceholder"), {
      target: { value: "Be helpful." },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    const draft = onSave.mock.calls[0]![0] as Partial<Character>
    for (const field of AGENT_OVERRIDE_FIELDS) expect(draft[field]).toBeUndefined()
  })

  it("keeps the overrides collapsed until opened, then saves an edit made there", async () => {
    const user = userEvent.setup()
    const { onSave } = renderEditor(baseInitial())
    expect(screen.queryByRole("combobox", { name: "ocr.label" })).not.toBeInTheDocument()

    await user.click(screen.getByTestId("agent-advanced-overrides"))
    await user.click(screen.getByRole("combobox", { name: "ocr.label" }))
    await user.click(screen.getByRole("option", { name: "off" }))
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    const payload = onSave.mock.calls[0]![0] as Partial<Character>
    expect(payload.enableOcr).toBe(false)
    expect(payload.providerId).toBeUndefined()
  })

  it("clears a stored override that is switched back to inherit", async () => {
    const user = userEvent.setup()
    const { onSave } = renderEditor(
      baseInitial({ overrides: pickAgentOverrides({ workspaceConfinementEnabled: false }) })
    )
    await user.click(screen.getByTestId("agent-advanced-overrides"))
    await user.click(screen.getByRole("combobox", { name: "workspaceConfinement.label" }))
    await user.click(screen.getByRole("option", { name: "inherit" }))
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    const payload = onSave.mock.calls[0]![0] as Partial<Character>
    expect(payload).toHaveProperty("workspaceConfinementEnabled", undefined)
  })
})

describe("CharacterEditor — default runtime (ADR-0220)", () => {
  it("saves the picked runtime and clears it when switched back to the app default", async () => {
    const { onSave } = renderEditor(baseInitial())
    expect(screen.getByTestId("runtime-value")).toHaveTextContent("default")

    fireEvent.click(screen.getByRole("button", { name: "pick-codex" }))
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave.mock.calls[0]![0]).toMatchObject({
      runtime: { kind: "external", agentId: "codex", name: "Codex" },
    })

    fireEvent.click(screen.getByRole("button", { name: "pick-default" }))
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2))
    expect(onSave.mock.calls[1]![0]).toHaveProperty("runtime", undefined)
  })
})

describe("CharacterEditor — controlled mode", () => {
  function renderControlled(value: EditorState) {
    const onValueChange = jest.fn()
    const onSave = jest.fn(async () => undefined)
    const view = render(
      <CharacterEditor
        initial={value}
        value={value}
        onValueChange={onValueChange}
        skillsCatalog={[]}
        mcpCatalog={[]}
        knowledgeBaseCatalog={[]}
        submitLabel="Create"
        cancelLabel="Discard"
        onCancel={() => undefined}
        onSave={onSave}
        chrome="plain"
        footerStart={<span>status line</span>}
      />
    )
    const rerender = (next: EditorState) =>
      view.rerender(
        <CharacterEditor
          initial={value}
          value={next}
          onValueChange={onValueChange}
          skillsCatalog={[]}
          mcpCatalog={[]}
          knowledgeBaseCatalog={[]}
          submitLabel="Create"
          cancelLabel="Discard"
          onCancel={() => undefined}
          onSave={onSave}
          chrome="plain"
          footerStart={<span>status line</span>}
        />
      )
    return { onValueChange, onSave, rerender }
  }

  it("reports each edit to the host", async () => {
    const { onValueChange } = renderControlled(baseInitial())
    fireEvent.change(screen.getByPlaceholderText("descriptionPlaceholder"), {
      target: { value: "Reviews PRs" },
    })
    await waitFor(() =>
      expect(onValueChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ description: "Reviews PRs" })
      )
    )
  })

  it("adopts a value the host writes, and does not echo it back", () => {
    const { onValueChange, rerender } = renderControlled(baseInitial())
    rerender(baseInitial({ name: "Written by the builder", allowedTools: ["Read", "Grep"] }))
    expect(screen.getByPlaceholderText("namePlaceholder")).toHaveValue("Written by the builder")
    expect(screen.getByPlaceholderText("allowedToolsPlaceholder")).toHaveValue("Read, Grep")
    expect(onValueChange).not.toHaveBeenCalled()
  })

  it("parses the typed tool list into the state", async () => {
    const { onValueChange } = renderControlled(baseInitial())
    fireEvent.change(screen.getByPlaceholderText("disallowedToolsPlaceholder"), {
      target: { value: "Bash, Write" },
    })
    await waitFor(() =>
      expect(onValueChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ disallowedTools: ["Bash", "Write"] })
      )
    )
    expect(screen.getByPlaceholderText("disallowedToolsPlaceholder")).toHaveValue("Bash, Write")
  })

  it("renders the host's footer labels and status line, without a card frame", () => {
    renderControlled(baseInitial())
    expect(screen.getByRole("button", { name: "Discard" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Create" })).toBeInTheDocument()
    expect(screen.getByText("status line")).toBeInTheDocument()
  })

  it("refuses to save an agent without instructions and says why", async () => {
    const { onSave } = renderControlled(baseInitial({ systemPrompt: "  " }))
    fireEvent.click(screen.getByRole("button", { name: "Create" }))
    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith("validation.systemPromptRequired")
    )
    expect(onSave).not.toHaveBeenCalled()
  })
})
