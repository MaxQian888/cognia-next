import type { ReactNode } from "react"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { toast } from "sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { EnhanceButton } from "./enhance-button"

const settingsState = { settings: { composerAssistance: {} } as Record<string, unknown> }
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: { getState: () => settingsState },
}))

const mockBuildClient = jest.fn()
jest.mock("@/lib/ai/generation/utility-client", () => ({
  buildUtilityLlmClient: (...a: unknown[]) => mockBuildClient(...a),
}))

const mockEnhance = jest.fn()
jest.mock("@/lib/chat/completion/enhance", () => ({
  ENHANCE_MODES: ["improve", "variants"],
  enhancePrompt: (...a: unknown[]) => mockEnhance(...a),
}))

jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() },
}))

// Render the dropdown contents inline — driving the real Radix portal + pointer
// capture through userEvent is flaky under parallel test load. We only need to
// exercise our own run/apply logic, not Radix internals.
jest.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  // Return the child element directly (not wrapped in a fragment) so the
  // outer TooltipTrigger asChild Slot can still clone/ref it.
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => children,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onSelect }: { children: ReactNode; onSelect?: () => void }) => (
    <button type="button" onClick={() => onSelect?.()}>
      {children}
    </button>
  ),
}))

function renderButton(props?: Partial<Parameters<typeof EnhanceButton>[0]>) {
  const onApply = jest.fn()
  render(
    <TooltipProvider>
      <EnhanceButton value="make a thing" onApply={onApply} session={null} {...props} />
    </TooltipProvider>
  )
  return { onApply }
}

async function pickMode(user: ReturnType<typeof userEvent.setup>, label: string) {
  // The dropdown content is rendered inline by the mock, so the item is
  // already in the DOM — click it directly (no need to open the menu).
  await user.click(await screen.findByText(label))
}

describe("EnhanceButton", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    settingsState.settings = { composerAssistance: {} }
    mockBuildClient.mockReturnValue({ complete: async () => "x" })
  })

  it("shows a preview for a rewrite and applies it", async () => {
    const user = userEvent.setup()
    mockEnhance.mockResolvedValue({ kind: "rewrite", text: "Make a polished thing." })
    const { onApply } = renderButton()
    await pickMode(user, "Improve")
    expect(await screen.findByText("Make a polished thing.")).toBeInTheDocument()
    await user.click(screen.getByText("Apply"))
    expect(onApply).toHaveBeenCalledWith("Make a polished thing.")
    expect(toast.success).toHaveBeenCalled()
  })

  it("cancels a rewrite preview without applying", async () => {
    const user = userEvent.setup()
    mockEnhance.mockResolvedValue({ kind: "rewrite", text: "Better." })
    const { onApply } = renderButton()
    await pickMode(user, "Improve")
    await user.click(await screen.findByText("Cancel"))
    expect(onApply).not.toHaveBeenCalled()
  })

  it("lists variants and applies the clicked one", async () => {
    const user = userEvent.setup()
    mockEnhance.mockResolvedValue({ kind: "variants", variants: ["Option A", "Option B"] })
    const { onApply } = renderButton()
    await pickMode(user, "Suggest variants")
    await user.click(await screen.findByText("Option B"))
    expect(onApply).toHaveBeenCalledWith("Option B")
  })

  it("shows an info toast and no dialog when skipped (pii)", async () => {
    const user = userEvent.setup()
    mockEnhance.mockResolvedValue({ kind: "skipped", reason: "pii" })
    renderButton()
    await pickMode(user, "Improve")
    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith(
        "Draft contains sensitive data — enhancement skipped."
      )
    )
    expect(screen.queryByText("Apply")).not.toBeInTheDocument()
  })

  it("shows the empty-draft info toast", async () => {
    const user = userEvent.setup()
    mockEnhance.mockResolvedValue({ kind: "skipped", reason: "empty" })
    renderButton()
    await pickMode(user, "Improve")
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith("Nothing to enhance yet."))
  })

  it("shows the no-output info toast", async () => {
    const user = userEvent.setup()
    mockEnhance.mockResolvedValue({ kind: "skipped", reason: "no-output" })
    renderButton()
    await pickMode(user, "Improve")
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith("No improvement suggested."))
  })

  it("closes the preview dialog on Escape without applying", async () => {
    const user = userEvent.setup()
    mockEnhance.mockResolvedValue({ kind: "rewrite", text: "Refined." })
    const { onApply } = renderButton()
    await pickMode(user, "Improve")
    expect(await screen.findByText("Refined.")).toBeInTheDocument()
    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByText("Refined.")).not.toBeInTheDocument())
    expect(onApply).not.toHaveBeenCalled()
  })

  it("errors when no model client can be built", async () => {
    const user = userEvent.setup()
    mockBuildClient.mockReturnValue(null)
    renderButton()
    await pickMode(user, "Improve")
    expect(toast.error).toHaveBeenCalledWith("Configure a model in Settings to enhance prompts.")
    expect(mockEnhance).not.toHaveBeenCalled()
  })

  it("surfaces an error toast when enhancement throws", async () => {
    const user = userEvent.setup()
    mockEnhance.mockRejectedValue(new Error("boom"))
    renderButton()
    await pickMode(user, "Improve")
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Couldn't enhance the prompt."))
  })

  it("is disabled when the disabled prop is set", () => {
    renderButton({ disabled: true })
    expect(screen.getByTestId("composer-enhance-trigger")).toBeDisabled()
  })
})
