/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { Dialog } from "@cognia/plugin-ui"
import { PlaywrightSetupModal } from "./setup-modal"
import { setPluginShell } from "../runtime"

jest.mock("next-intl", () => ({ useLocale: () => "zh-CN" }))
const mockPush = jest.fn()
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: mockPush }) }))

const renderModal = (args?: Record<string, unknown>, onClose = jest.fn()) =>
  // The host mounts plugin modals inside <Dialog><DialogContent>; the bare
  // <Dialog> root supplies the Radix context DialogTitle/Description need.
  render(
    <Dialog open>
      <PlaywrightSetupModal onClose={onClose} modalId="m" args={args} />
    </Dialog>
  )

const okShell = () => ({
  execute: jest.fn(async (command: string) => ({
    code: 0,
    success: true,
    stdout: command === "node" ? "v22.11.0\n" : "10.9.2\n",
    stderr: "",
  })),
})

afterEach(() => {
  setPluginShell(undefined)
  mockPush.mockClear()
})

describe("PlaywrightSetupModal", () => {
  it("renders the localized guide with all four presets", () => {
    renderModal()
    expect(screen.getByText("配置 Playwright 浏览器")).toBeInTheDocument()
    for (const id of [
      "playwright",
      "playwright-isolated",
      "playwright-existing-browser",
      "playwright-cdp",
    ]) {
      expect(screen.getByTestId(`mode-${id}`)).toBeInTheDocument()
    }
    // Preset titles stay English so they match the gallery cards the CTAs land on.
    expect(screen.getByText("Playwright — Attach over CDP")).toBeInTheDocument()
    // Requirement chips + the extension safety note are localized.
    expect(screen.getAllByText("需要 Node.js 与 npx").length).toBeGreaterThan(0)
    expect(screen.getByText("需要官方 Playwright 扩展")).toBeInTheDocument()
    expect(screen.getByText(/browser_run_code_unsafe/)).toBeInTheDocument()
  })

  it("deep-links a mode into the MCP gallery and closes", () => {
    const onClose = jest.fn()
    renderModal(undefined, onClose)
    fireEvent.click(screen.getByTestId("setup-playwright-cdp"))
    // The `?preset=` param is the MCP panel's deep-link contract — pinned so
    // a rename there fails loudly here rather than silently 404ing users.
    expect(mockPush).toHaveBeenCalledWith("/settings?section=mcp&preset=playwright-cdp")
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("highlights the card named by the focus arg", () => {
    renderModal({ focus: "playwright-existing-browser" })
    expect(screen.getByTestId("mode-playwright-existing-browser").className).toContain(
      "border-primary"
    )
    expect(screen.getByTestId("mode-playwright").className).not.toContain("border-primary")
  })

  it("runs node/npx version checks and reports the toolchain versions", async () => {
    const shell = okShell()
    setPluginShell(shell as never)
    renderModal()
    fireEvent.click(screen.getByTestId("env-check-run"))
    await waitFor(() => expect(screen.getByText(/v22\.11\.0/)).toBeInTheDocument())
    expect(shell.execute).toHaveBeenCalledWith("node", { args: ["--version"] })
    expect(shell.execute).toHaveBeenCalledWith("npx", { args: ["--version"] })
    expect(screen.getByText(/10\.9\.2/)).toBeInTheDocument()
  })

  it("reports missing when the toolchain check exits non-zero", async () => {
    setPluginShell({
      execute: jest.fn(async () => ({
        code: 127,
        success: false,
        stdout: "",
        stderr: "not found",
      })),
    } as never)
    renderModal()
    fireEvent.click(screen.getByTestId("env-check-run"))
    await waitFor(() => expect(screen.getByText(/未找到 Node\.js 或 npx/)).toBeInTheDocument())
  })

  it("reports an error when the command is denied or throws", async () => {
    setPluginShell({ execute: jest.fn(async () => Promise.reject(new Error("denied"))) } as never)
    renderModal()
    fireEvent.click(screen.getByTestId("env-check-run"))
    await waitFor(() => expect(screen.getByText(/检查未能执行/)).toBeInTheDocument())
  })

  it("shows the unavailable state and hides the button when no shell API is published", () => {
    renderModal()
    expect(screen.queryByTestId("env-check-run")).not.toBeInTheDocument()
    expect(screen.getByText(/无法执行检查/)).toBeInTheDocument()
  })

  it("closes via the footer button", () => {
    const onClose = jest.fn()
    renderModal(undefined, onClose)
    fireEvent.click(screen.getByRole("button", { name: "关闭" }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
