import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { CopyButton } from "./copy-button"

const writeText = jest.fn<Promise<void>, [string]>()

function installClipboard() {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
    writable: true,
  })
}

/**
 * `userEvent.setup()` installs its own `navigator.clipboard` stub, so the spy
 * has to be put back *after* it — otherwise the component writes to
 * user-event's clipboard and the assertions here see zero calls.
 */
function setupUser() {
  const user = userEvent.setup()
  installClipboard()
  return user
}

beforeEach(() => {
  writeText.mockReset()
  writeText.mockResolvedValue(undefined)
  installClipboard()
})

function renderButton(value = "pnpm install") {
  return render(<CopyButton value={value} copyLabel="Copy" copiedLabel="Copied" />)
}

describe("CopyButton", () => {
  it("offers to copy the command", () => {
    renderButton()
    expect(screen.getByRole("button", { name: /Copy/ })).toBeInTheDocument()
  })

  it("copies the exact command it was given", async () => {
    const user = setupUser()
    renderButton("pnpm tauri build")
    await user.click(screen.getByRole("button", { name: /Copy/ }))
    expect(writeText).toHaveBeenCalledWith("pnpm tauri build")
  })

  it("confirms the copy in the label, where a screen reader will hear it", async () => {
    const user = setupUser()
    renderButton()
    await user.click(screen.getByRole("button", { name: /Copy/ }))
    await waitFor(() => expect(screen.getByText("Copied")).toBeInTheDocument())
  })

  it("stays on the copy label when the clipboard write is refused", async () => {
    // A denied clipboard permission must not claim success.
    writeText.mockRejectedValue(new Error("denied"))
    const user = setupUser()
    renderButton()
    await user.click(screen.getByRole("button", { name: /Copy/ }))
    await waitFor(() => expect(writeText).toHaveBeenCalled())
    expect(screen.queryByText("Copied")).toBeNull()
  })

  it("renders nothing where there is no clipboard, rather than a dead control", () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true })
    const { container } = renderButton()
    expect(container).toBeEmptyDOMElement()
  })
})
