/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { registerPluginI18n, unregisterPluginI18n } from "@cognia/plugin-sdk/api/i18n"
import { Dialog } from "@cognia/plugin-ui"
import manifestJson from "../../plugin.json"
import { PLUGIN_ID } from "../ids"
import { PlaywrightSetupModal } from "./setup-modal"
import { setSetupModalHost, type SetupModalHost } from "../runtime"

const EN = manifestJson.i18n.locales.en
const ZH = manifestJson.i18n.locales["zh-CN"]

/**
 * Register the plugin's own bundle the way the manager does on enable. The
 * test host renders in English, so the Chinese bundle is registered as the
 * active locale's to prove every string comes from the bundle rather than
 * from a literal in the component.
 */
function registerBundle(locale: Record<string, string>): void {
  registerPluginI18n({
    pluginId: PLUGIN_ID,
    messages: {
      en: Object.fromEntries(
        Object.entries(locale).map(([key, value]) => [`plugin.${PLUGIN_ID}.${key}`, value])
      ),
    },
  })
}

const navigate = jest.fn(() => true)
function publishHost(shell?: SetupModalHost["shell"]): void {
  setSetupModalHost({ shell: shell ?? { execute: jest.fn() }, navigate })
}

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

beforeEach(() => registerBundle(ZH))

afterEach(() => {
  setSetupModalHost(undefined)
  unregisterPluginI18n(PLUGIN_ID)
  navigate.mockClear()
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

  it("renders English from the same bundle", () => {
    registerBundle(EN)
    renderModal()
    expect(screen.getByRole("heading", { name: EN["modal.title"] })).toBeInTheDocument()
  })

  it("deep-links a mode into the MCP gallery through ctx.ui.navigate and closes", () => {
    publishHost()
    const onClose = jest.fn()
    renderModal(undefined, onClose)
    fireEvent.click(screen.getByTestId("setup-playwright-cdp"))
    // The `?preset=` param is the MCP panel's deep-link contract — pinned so
    // a rename there fails loudly here rather than silently 404ing users.
    expect(navigate).toHaveBeenCalledWith("/settings?section=mcp&preset=playwright-cdp")
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("keeps every action at least 36px tall on narrow touch screens", () => {
    publishHost()
    renderModal()
    for (const button of screen.getAllByRole("button")) {
      if (button.getAttribute("data-slot") === "dialog-close") continue
      expect(button.className).toMatch(/(^|\s)h-9(\s|$)/)
    }
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
    publishHost(shell)
    renderModal()
    fireEvent.click(screen.getByTestId("env-check-run"))
    await waitFor(() => expect(screen.getByText(/v22\.11\.0/)).toBeInTheDocument())
    expect(shell.execute).toHaveBeenCalledWith("node", { args: ["--version"] })
    expect(shell.execute).toHaveBeenCalledWith("npx", { args: ["--version"] })
    expect(screen.getByText(/10\.9\.2/)).toBeInTheDocument()
  })

  it("reports missing when the toolchain check exits non-zero", async () => {
    publishHost({
      execute: jest.fn(async () => ({
        code: 127,
        success: false,
        stdout: "",
        stderr: "not found",
      })),
    })
    renderModal()
    fireEvent.click(screen.getByTestId("env-check-run"))
    await waitFor(() => expect(screen.getByText(/未找到 Node\.js 或 npx/)).toBeInTheDocument())
  })

  it("reports an error when the command is denied or throws", async () => {
    publishHost({ execute: jest.fn(async () => Promise.reject(new Error("denied"))) })
    renderModal()
    fireEvent.click(screen.getByTestId("env-check-run"))
    await waitFor(() => expect(screen.getByText(/检查未能执行/)).toBeInTheDocument())
  })

  it("shows the unavailable state and hides the button when the plugin host is not published", () => {
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
