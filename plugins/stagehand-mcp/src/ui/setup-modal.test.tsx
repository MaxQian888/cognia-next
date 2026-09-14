/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { Dialog } from "@cognia/plugin-ui"
import { StagehandSetupModal } from "./setup-modal"
import { setPluginShell } from "../runtime"

jest.mock("next-intl", () => ({ useLocale: () => "zh-CN" }))
const mockPush = jest.fn()
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: mockPush }) }))

const renderModal = (args?: Record<string, unknown>, onClose = jest.fn()) =>
  // The host mounts plugin modals inside <Dialog><DialogContent>; the bare
  // <Dialog> root supplies the Radix context DialogTitle/Description need.
  render(
    <Dialog open>
      <StagehandSetupModal onClose={onClose} modalId="m" args={args} />
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

describe("StagehandSetupModal", () => {
  it("renders the localized guide with both presets and the hosted recommendation", () => {
    renderModal()
    expect(screen.getByText("配置 Stagehand 浏览器")).toBeInTheDocument()
    expect(screen.getByTestId("mode-stagehand-hosted")).toBeInTheDocument()
    expect(screen.getByTestId("mode-stagehand")).toBeInTheDocument()
    // Preset titles stay English so they match the gallery cards the CTAs land on.
    expect(screen.getByText("Stagehand — Hosted")).toBeInTheDocument()
    expect(screen.getByText("Stagehand — Self-hosted")).toBeInTheDocument()
    // The hosted card carries the recommended badge; requirement chips are localized.
    expect(screen.getByText("推荐")).toBeInTheDocument()
    expect(screen.getByText("无需本地 Node.js")).toBeInTheDocument()
    expect(screen.getByText("需要 Node.js 与 npx")).toBeInTheDocument()
    expect(screen.getByText("支持全部 CLI 参数")).toBeInTheDocument()
  })

  it("deep-links a mode into the MCP gallery and closes", () => {
    const onClose = jest.fn()
    renderModal(undefined, onClose)
    fireEvent.click(screen.getByTestId("setup-stagehand-hosted"))
    // The `?preset=` param is the MCP panel's deep-link contract — pinned so
    // a rename there fails loudly here rather than silently 404ing users.
    expect(mockPush).toHaveBeenCalledWith("/settings?section=mcp&preset=stagehand-hosted")
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("highlights the card named by the focus arg", () => {
    renderModal({ focus: "stagehand" })
    expect(screen.getByTestId("mode-stagehand").className).toContain("border-primary")
    expect(screen.getByTestId("mode-stagehand-hosted").className).not.toContain("border-primary")
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

  it("scopes the environment check to the self-hosted option", () => {
    // The hosted preset needs nothing local — the section must say so or
    // users will think the check gates both cards.
    renderModal()
    expect(screen.getByText("环境 —— 仅自托管需要")).toBeInTheDocument()
  })

  it("closes via the footer button", () => {
    const onClose = jest.fn()
    renderModal(undefined, onClose)
    fireEvent.click(screen.getByRole("button", { name: "关闭" }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
