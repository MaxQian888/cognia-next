/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({ useTranslations: () => (k: string) => k }))
jest.mock("sonner", () => ({ toast: { error: jest.fn() } }))

let mockIsTauri = true
jest.mock("@/lib/tauri", () => ({ isTauri: () => mockIsTauri }))
jest.mock("@/lib/codeserver/client", () => ({
  codeServerClient: { localVsCodeAvailable: jest.fn(), openInLocalVsCode: jest.fn() },
}))

import { codeServerClient } from "@/lib/codeserver/client"
import { toast } from "sonner"
import { EditorEngineToggle } from "./editor-engine-toggle"
import type { CodeServerSupportStatus } from "@/hooks/codeserver/use-code-server-supported"

const client = codeServerClient as jest.Mocked<typeof codeServerClient>
const toasts = toast as unknown as { error: jest.Mock }

const renderToggle = (
  props: Partial<{
    value: "monaco" | "codeserver"
    onChange: (next: "monaco" | "codeserver") => void
    proIdeSupport: CodeServerSupportStatus
  }> = {}
) => {
  const onChange = props.onChange ?? jest.fn()
  render(
    <EditorEngineToggle
      value={props.value ?? "monaco"}
      onChange={onChange}
      proIdeSupport={props.proIdeSupport ?? "supported"}
      projectRoot="/work/proj"
    />
  )
  return { onChange }
}

beforeEach(() => {
  mockIsTauri = true
  client.localVsCodeAvailable.mockReset().mockResolvedValue(true)
  client.openInLocalVsCode.mockReset().mockResolvedValue(undefined)
  toasts.error.mockReset()
})

it("exposes a single-choice radiogroup rather than two loose buttons", () => {
  renderToggle()

  // The hand-rolled predecessor was a role="group" of aria-pressed buttons,
  // which announces "two independent toggles" instead of one exclusive choice.
  expect(screen.getByRole("radiogroup", { name: "proIde.switchLabel" })).toBeInTheDocument()
  expect(screen.getAllByRole("radio")).toHaveLength(2)
  expect(screen.getByTestId("editor-mode-monaco")).toHaveAttribute("aria-checked", "true")
  expect(screen.getByTestId("editor-mode-codeserver")).toHaveAttribute("aria-checked", "false")
})

it("marks the active engine as pressed", () => {
  renderToggle({ value: "codeserver" })

  expect(screen.getByTestId("editor-mode-codeserver")).toHaveAttribute("aria-checked", "true")
  expect(screen.getByTestId("editor-mode-monaco")).toHaveAttribute("aria-checked", "false")
})

it("reports the picked engine", () => {
  const { onChange } = renderToggle({ value: "monaco" })

  fireEvent.click(screen.getByTestId("editor-mode-codeserver"))
  expect(onChange).toHaveBeenCalledWith("codeserver")
})

it("is a single roving tab stop so the group is one Tab away", () => {
  // Radix drives arrow-key movement between the items itself (not asserted here
  // — its roving focus needs real layout that jsdom does not provide). What this
  // component owes is the structure that makes it possible: both items are
  // collection members carrying an explicit tabindex.
  renderToggle({ value: "monaco" })

  for (const id of ["editor-mode-monaco", "editor-mode-codeserver"]) {
    const item = screen.getByTestId(id)
    expect(item).toHaveAttribute("data-radix-collection-item")
    expect(item).toHaveAttribute("tabindex")
  }
})

it("keeps an engine selected when the active one is clicked again", () => {
  const { onChange } = renderToggle({ value: "monaco" })

  // Radix would emit "" here; the host must never be left with no engine.
  fireEvent.click(screen.getByTestId("editor-mode-monaco"))

  expect(onChange).not.toHaveBeenCalled()
})

it("disables Pro IDE with an explanation when the platform has no binary", async () => {
  renderToggle({ proIdeSupport: "unsupported" })

  const proIde = screen.getByTestId("editor-mode-codeserver")
  expect(proIde).toBeDisabled()
  expect(proIde).toHaveAttribute("title", "proIde.disabledTooltip")
  // Let the fallback probe settle so its setState lands inside act().
  await screen.findByTestId("editor-open-local-vscode")
})

it("leaves the tooltip off when Pro IDE is available", () => {
  renderToggle({ proIdeSupport: "supported" })

  expect(screen.getByTestId("editor-mode-codeserver")).not.toHaveAttribute("title")
})

describe("local VS Code fallback", () => {
  it("is absent while the embedded Pro IDE is available", async () => {
    renderToggle({ proIdeSupport: "supported" })
    await waitFor(() => expect(client.localVsCodeAvailable).not.toHaveBeenCalled())
    expect(screen.queryByTestId("editor-open-local-vscode")).not.toBeInTheDocument()
  })

  it("offers the project root to the user's own VS Code where Pro IDE has no build", async () => {
    renderToggle({ proIdeSupport: "unsupported" })

    const open = await screen.findByTestId("editor-open-local-vscode")
    fireEvent.click(open)

    await waitFor(() => expect(client.openInLocalVsCode).toHaveBeenCalledWith("/work/proj"))
  })

  it("stays hidden when no local `code` launcher exists", async () => {
    // Otherwise the button would promise something the machine cannot do.
    client.localVsCodeAvailable.mockResolvedValue(false)
    renderToggle({ proIdeSupport: "unsupported" })

    await waitFor(() => expect(client.localVsCodeAvailable).toHaveBeenCalled())
    expect(screen.queryByTestId("editor-open-local-vscode")).not.toBeInTheDocument()
  })

  it("reports a failed launch", async () => {
    client.openInLocalVsCode.mockRejectedValueOnce(new Error("ENOENT"))
    renderToggle({ proIdeSupport: "unsupported" })

    fireEvent.click(await screen.findByTestId("editor-open-local-vscode"))

    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith("proIde.localVsCodeFailed"))
  })

  it("does not probe outside the desktop shell", async () => {
    mockIsTauri = false
    renderToggle({ proIdeSupport: "unsupported" })

    await waitFor(() => expect(client.localVsCodeAvailable).not.toHaveBeenCalled())
    expect(screen.queryByTestId("editor-open-local-vscode")).not.toBeInTheDocument()
  })

  it("distinguishes a failed support probe from an unsupported platform", async () => {
    renderToggle({ proIdeSupport: "error" })

    expect(screen.getByTestId("editor-mode-codeserver")).toHaveAttribute(
      "title",
      "proIde.supportCheckFailed"
    )
    await waitFor(() => expect(client.localVsCodeAvailable).not.toHaveBeenCalled())
    expect(screen.queryByTestId("editor-open-local-vscode")).not.toBeInTheDocument()
  })
})
