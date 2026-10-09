/** @jest-environment jsdom */

// The "…" menu of one agent (ADR-0220). What it offers follows
// `describeAgentSource`, and every item runs a `useAgentActions` method.

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { Character } from "@cognia/agent-config-types"

const mockActions = {
  duplicate: jest.fn(),
  createVariant: jest.fn(),
  detachVariant: jest.fn(),
  resetVariant: jest.fn(),
  remove: jest.fn(),
  removeMany: jest.fn(),
  exportMany: jest.fn(),
  exportPack: jest.fn(),
  recloneFromPack: jest.fn(),
  dismissUpdate: jest.fn(),
  applyUpdateForPack: jest.fn(),
  requestApplyUpdate: jest.fn(),
  applyUpdateTarget: null as Character | null,
  confirmApplyUpdate: jest.fn(),
  cancelApplyUpdate: jest.fn(),
}
jest.mock("@/hooks/agents/use-agent-actions", () => ({
  useAgentActions: () => mockActions,
}))

// The live pack the clones below were taken from has moved on to 2.0.0.
jest.mock("@/lib/plugin/registries/character-pack-registry", () => ({
  ...jest.requireActual("@/lib/plugin/registries/character-pack-registry"),
  listCharacterPackEntries: jest.fn(() => [
    { pluginId: "plug", entry: { id: "pack", version: "2.0.0" } },
  ]),
  getPackWarnings: jest.fn(() => []),
  getPackCharacterWarnings: jest.fn(() => []),
}))

jest.mock("@/components/settings/character-pack-update-dialog", () => ({
  CharacterPackUpdateDialog: (props: {
    open: boolean
    characterId: string | null
    characterName: string
    onCancel: () => void
    onConfirm: () => void
  }) =>
    props.open ? (
      <div data-testid="pack-update-dialog" data-character-id={props.characterId}>
        <span>{props.characterName}</span>
        <button type="button" onClick={props.onCancel}>
          stub-cancel
        </button>
        <button type="button" onClick={props.onConfirm}>
          stub-confirm
        </button>
      </div>
    ) : null,
}))

import { AgentActionsMenu, type AgentActionsMenuProps } from "./agent-actions-menu"

function agent(over: Partial<Character> = {}): Character {
  return {
    id: "char_1",
    name: "Alpha",
    avatarColor: "#123456",
    systemPrompt: "",
    createdAt: 1,
    updatedAt: 2,
    ...over,
  } as Character
}

/** A clone of pack `pack` from plugin `plug`, taken at version 1.0.0. */
function clone(over: Partial<Character> = {}): Character {
  return agent({
    sourcePluginId: "plug",
    sourcePackId: "pack",
    packVersionAtClone: "1.0.0",
    clonedFromPackCharacterId: "cognia-pack:plug:pack:helper",
    ...over,
  })
}

const onOpenAgent = jest.fn()

async function open(a: Character, props: Partial<AgentActionsMenuProps> = {}) {
  const user = userEvent.setup()
  render(<AgentActionsMenu agent={a} onOpenAgent={onOpenAgent} {...props} />)
  await user.click(screen.getByTestId("agent-actions-trigger"))
  return user
}

const item = (name: string | RegExp) => screen.getByRole("menuitem", { name })
const queryItem = (name: string | RegExp) => screen.queryByRole("menuitem", { name })

beforeEach(() => {
  jest.clearAllMocks()
  mockActions.applyUpdateTarget = null
  mockActions.duplicate.mockResolvedValue(undefined)
  mockActions.createVariant.mockResolvedValue(undefined)
  mockActions.recloneFromPack.mockResolvedValue(undefined)
  mockActions.remove.mockResolvedValue(true)
})

describe("trigger", () => {
  it("names the agent in its accessible label", () => {
    render(<AgentActionsMenu agent={agent()} onOpenAgent={onOpenAgent} />)
    expect(screen.getByTestId("agent-actions-trigger")).toHaveAccessibleName(
      "More actions for Alpha"
    )
  })

  it("applies a caller-supplied trigger class instead of the default size", () => {
    render(
      <AgentActionsMenu agent={agent()} onOpenAgent={onOpenAgent} triggerClassName="size-10" />
    )
    const trigger = screen.getByTestId("agent-actions-trigger")
    expect(trigger.className).toContain("size-10")
    expect(trigger.className).not.toContain("size-8")
  })
})

describe("items for a plain user agent", () => {
  it("offers duplicate, variant and delete, and nothing pack-related", async () => {
    await open(agent())
    expect(item("Duplicate")).toBeInTheDocument()
    expect(item("Create variant")).toBeInTheDocument()
    expect(item("Delete")).toBeInTheDocument()
    expect(queryItem("Chat with agent")).not.toBeInTheDocument()
    expect(queryItem("Edit")).not.toBeInTheDocument()
    expect(queryItem("Export pack")).not.toBeInTheDocument()
    expect(queryItem("Apply update")).not.toBeInTheDocument()
    expect(queryItem("Reset overrides")).not.toBeInTheDocument()
    expect(queryItem("Detach from base")).not.toBeInTheDocument()
  })

  it("offers Chat only when the host passes onStartChat, and runs it", async () => {
    const onStartChat = jest.fn()
    const user = await open(agent(), { onStartChat })
    await user.click(item("Chat with agent"))
    expect(onStartChat).toHaveBeenCalledTimes(1)
  })

  it("offers Edit for an editable agent when the host passes onEdit", async () => {
    const onEdit = jest.fn()
    const user = await open(agent(), { onEdit })
    await user.click(item("Edit"))
    expect(onEdit).toHaveBeenCalledTimes(1)
  })
})

describe("items for read-only agents", () => {
  it("never shows Delete for a built-in agent, nor Edit even when onEdit is given", async () => {
    await open(agent({ isBuiltIn: true }), { onEdit: jest.fn() })
    expect(queryItem("Delete")).not.toBeInTheDocument()
    expect(queryItem("Edit")).not.toBeInTheDocument()
    expect(item("Duplicate")).toBeInTheDocument()
  })

  it("does not offer Edit for the immutable support agent, even though it is a Dexie row", async () => {
    await open(agent({ id: "char_builtin_support" }), { onEdit: jest.fn() })
    expect(queryItem("Edit")).not.toBeInTheDocument()
    expect(item("Delete")).toBeInTheDocument()
  })

  it("treats a plugin overlay as read-only but exportable", async () => {
    const user = await open(agent({ id: "cognia-pack:plug:pack:helper" }), { onEdit: jest.fn() })
    expect(queryItem("Delete")).not.toBeInTheDocument()
    expect(queryItem("Edit")).not.toBeInTheDocument()
    await user.click(item("Export pack"))
    expect(mockActions.exportPack).toHaveBeenCalledWith(
      expect.objectContaining({ id: "cognia-pack:plug:pack:helper" })
    )
  })
})

describe("duplicate and variants", () => {
  it("opens the copy in edit mode after duplicating", async () => {
    const a = agent()
    mockActions.duplicate.mockResolvedValue({ id: "copy_1" })
    const user = await open(a)
    await user.click(item("Duplicate"))
    expect(mockActions.duplicate).toHaveBeenCalledWith(a)
    await waitFor(() => expect(onOpenAgent).toHaveBeenCalledWith("copy_1", "edit"))
  })

  it("opens nothing when the duplicate failed", async () => {
    const user = await open(agent())
    await user.click(item("Duplicate"))
    await waitFor(() => expect(mockActions.duplicate).toHaveBeenCalled())
    await Promise.resolve()
    expect(onOpenAgent).not.toHaveBeenCalled()
  })

  it("opens the new variant in edit mode", async () => {
    const a = agent()
    mockActions.createVariant.mockResolvedValue({ id: "variant_1" })
    const user = await open(a)
    await user.click(item("Create variant"))
    expect(mockActions.createVariant).toHaveBeenCalledWith(a)
    await waitFor(() => expect(onOpenAgent).toHaveBeenCalledWith("variant_1", "edit"))
  })

  it("opens nothing when the variant could not be created", async () => {
    const user = await open(agent())
    await user.click(item("Create variant"))
    await waitFor(() => expect(mockActions.createVariant).toHaveBeenCalled())
    await Promise.resolve()
    expect(onOpenAgent).not.toHaveBeenCalled()
  })

  it("lets a variant reset its overrides and detach from its base", async () => {
    const a = agent({ variant: { baseId: "base", ownFields: ["model"] } })
    const user = await open(a)
    await user.click(item("Reset overrides"))
    expect(mockActions.resetVariant).toHaveBeenCalledWith(a)
    await user.click(screen.getByTestId("agent-actions-trigger"))
    await user.click(item("Detach from base"))
    expect(mockActions.detachVariant).toHaveBeenCalledWith(a)
  })

  it("disables reset when the variant overrides nothing", async () => {
    const user = await open(
      agent({ variant: { baseId: "base", ownFields: [] } as Character["variant"] })
    )
    const reset = item("Reset overrides")
    expect(reset).toHaveAttribute("aria-disabled", "true")
    await user.click(reset)
    expect(mockActions.resetVariant).not.toHaveBeenCalled()
  })
})

describe("pack-clone updates", () => {
  it("offers the update actions for a clone whose pack has moved on", async () => {
    await open(clone())
    expect(screen.getByText("Update available")).toBeInTheDocument()
    expect(item("Apply update")).toBeInTheDocument()
    expect(item("Re-clone")).toBeInTheDocument()
    expect(item("Dismiss")).toBeInTheDocument()
    // The clone belongs to a pack, so it can be exported.
    expect(item("Export pack")).toBeInTheDocument()
  })

  it("hides the update actions when the clone is current", async () => {
    await open(clone({ packVersionAtClone: "2.0.0" }))
    expect(queryItem("Apply update")).not.toBeInTheDocument()
    expect(queryItem("Re-clone")).not.toBeInTheDocument()
    expect(queryItem("Dismiss")).not.toBeInTheDocument()
  })

  it("asks to apply the update to this clone", async () => {
    const a = clone()
    const user = await open(a)
    await user.click(item("Apply update"))
    expect(mockActions.requestApplyUpdate).toHaveBeenCalledWith(a)
  })

  it.each([0, 1])("hides apply-to-all with %i pending siblings", async (siblingPendingCount) => {
    await open(clone(), { siblingPendingCount })
    expect(queryItem(/Apply to all/)).not.toBeInTheDocument()
  })

  it("offers apply-to-all from two pending clones and runs it for the pack", async () => {
    const a = clone()
    const user = await open(a, { siblingPendingCount: 2 })
    await user.click(item("Apply to all (2)"))
    expect(mockActions.applyUpdateForPack).toHaveBeenCalledWith(a)
  })

  it("opens the fresh clone (without edit mode) after re-cloning", async () => {
    const a = clone()
    mockActions.recloneFromPack.mockResolvedValue({ id: "fresh_1" })
    const user = await open(a)
    await user.click(item("Re-clone"))
    expect(mockActions.recloneFromPack).toHaveBeenCalledWith(a)
    await waitFor(() => expect(onOpenAgent).toHaveBeenCalledWith("fresh_1"))
  })

  it("opens nothing when re-cloning produced nothing", async () => {
    const user = await open(clone())
    await user.click(item("Re-clone"))
    await waitFor(() => expect(mockActions.recloneFromPack).toHaveBeenCalled())
    await Promise.resolve()
    expect(onOpenAgent).not.toHaveBeenCalled()
  })

  it("dismisses the update", async () => {
    const a = clone()
    const user = await open(a)
    await user.click(item("Dismiss"))
    expect(mockActions.dismissUpdate).toHaveBeenCalledWith(a)
  })
})

describe("delete confirmation", () => {
  it("asks before deleting and names the agent", async () => {
    const user = await open(agent())
    await user.click(item("Delete"))
    expect(await screen.findByRole("alertdialog")).toHaveTextContent(/"Alpha" will be removed/)
    expect(mockActions.remove).not.toHaveBeenCalled()
  })

  it("keeps the agent when the dialog is cancelled", async () => {
    const user = await open(agent())
    await user.click(item("Delete"))
    await user.click(await screen.findByRole("button", { name: "Cancel" }))
    expect(mockActions.remove).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
  })

  it("removes the agent on confirm and reports it through onDeleted", async () => {
    const a = agent()
    const onDeleted = jest.fn()
    const user = await open(a, { onDeleted })
    await user.click(item("Delete"))
    await user.click(await screen.findByRole("button", { name: "Remove" }))
    expect(mockActions.remove).toHaveBeenCalledWith(a)
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1))
  })

  it("does not call onDeleted when the removal failed", async () => {
    mockActions.remove.mockResolvedValue(false)
    const onDeleted = jest.fn()
    const user = await open(agent(), { onDeleted })
    await user.click(item("Delete"))
    await user.click(await screen.findByRole("button", { name: "Remove" }))
    await waitFor(() => expect(mockActions.remove).toHaveBeenCalled())
    await Promise.resolve()
    expect(onDeleted).not.toHaveBeenCalled()
  })

  it("removes without a callback when onDeleted is absent", async () => {
    const user = await open(agent())
    await user.click(item("Delete"))
    await user.click(await screen.findByRole("button", { name: "Remove" }))
    await waitFor(() => expect(mockActions.remove).toHaveBeenCalled())
  })
})

describe("selective-overwrite confirmation", () => {
  it("is closed until an update is requested", () => {
    render(<AgentActionsMenu agent={agent()} onOpenAgent={onOpenAgent} />)
    expect(screen.queryByTestId("pack-update-dialog")).not.toBeInTheDocument()
  })

  it("opens for the requested clone and wires cancel and confirm to the actions", async () => {
    mockActions.applyUpdateTarget = clone({ id: "char_clone", name: "Cloney" })
    const user = userEvent.setup()
    render(<AgentActionsMenu agent={agent()} onOpenAgent={onOpenAgent} />)
    const dialog = screen.getByTestId("pack-update-dialog")
    expect(dialog).toHaveAttribute("data-character-id", "char_clone")
    expect(dialog).toHaveTextContent("Cloney")
    await user.click(screen.getByRole("button", { name: "stub-cancel" }))
    expect(mockActions.cancelApplyUpdate).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole("button", { name: "stub-confirm" }))
    expect(mockActions.confirmApplyUpdate).toHaveBeenCalledTimes(1)
  })
})
