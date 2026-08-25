/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: () => {
    const t = (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${JSON.stringify(values)}` : key
    return t
  },
}))

const getSettingsMock = jest.fn()
const setSettingsMock = jest.fn()
jest.mock("@/lib/db/plugins", () => ({
  getPythonHostSettings: (id: string) => getSettingsMock(id),
  setPythonHostSettings: (id: string, settings: unknown) => setSettingsMock(id, settings),
}))

const installDepsMock = jest.fn()
const runtimeInfoMock = jest.fn()
const installUvMock = jest.fn()
jest.mock("@/lib/plugin/core/manager", () => ({
  getPluginManager: jest.fn(() => ({
    installPythonDeps: installDepsMock,
    getPythonRuntimeInfo: runtimeInfoMock,
    installUv: installUvMock,
  })),
}))

import { PluginPythonHostSettings } from "./plugin-python-host-settings"

describe("PluginPythonHostSettings", () => {
  beforeEach(() => {
    getSettingsMock.mockReset()
    setSettingsMock.mockReset()
    installDepsMock.mockReset()
    runtimeInfoMock.mockReset()
    installUvMock.mockReset()
    getSettingsMock.mockResolvedValue(undefined)
    setSettingsMock.mockResolvedValue(undefined)
    installDepsMock.mockResolvedValue(undefined)
    // Default: no native host (the web shell), so the runtime strip is absent.
    runtimeInfoMock.mockRejectedValue(new Error("no native host"))
    installUvMock.mockResolvedValue("uv 0.5.0")
  })

  async function renderLoaded(deps: string[] = []) {
    render(<PluginPythonHostSettings pluginId="demo" pythonDependencies={deps} />)
    await waitFor(() => expect(screen.getByTestId("python-host-settings")).toBeInTheDocument())
  }

  it("loads persisted settings into the form", async () => {
    getSettingsMock.mockResolvedValue({
      interpreterPath: "C:/py/python.exe",
      env: { API_KEY: "secret" },
      callTimeoutMs: 5000,
      useVenv: false,
      idleShutdownMin: 15,
      maxConcurrentCalls: 2,
    })
    await renderLoaded()

    expect(screen.getByLabelText("interpreterPath")).toHaveValue("C:/py/python.exe")
    expect(screen.getByLabelText("env")).toHaveValue("API_KEY=secret")
    expect(screen.getByLabelText("callTimeoutMs")).toHaveValue(5000)
    expect(screen.getByLabelText("idleShutdownMin")).toHaveValue(15)
    expect(screen.getByLabelText("maxConcurrentCalls")).toHaveValue(2)
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false")
  })

  it("saves trimmed settings (empty fields become undefined)", async () => {
    await renderLoaded()
    fireEvent.change(screen.getByLabelText("interpreterPath"), { target: { value: "  " } })
    fireEvent.change(screen.getByLabelText("idleShutdownMin"), { target: { value: "10" } })
    fireEvent.click(screen.getByRole("button", { name: "save" }))

    await waitFor(() => expect(setSettingsMock).toHaveBeenCalled())
    expect(setSettingsMock).toHaveBeenCalledWith("demo", {
      interpreterPath: undefined,
      env: undefined,
      callTimeoutMs: undefined,
      useVenv: undefined,
      idleShutdownMin: 10,
      maxConcurrentCalls: undefined,
      maxOutboundHostCalls: undefined,
      installer: undefined,
      venvScope: undefined,
    })
    expect(await screen.findByRole("status")).toHaveTextContent("saved")
  })

  it("saves numeric fields and the venv opt-out; saved tick auto-clears", async () => {
    await renderLoaded()
    fireEvent.change(screen.getByLabelText("interpreterPath"), {
      target: { value: "D:/py/python.exe" },
    })
    fireEvent.change(screen.getByLabelText("callTimeoutMs"), { target: { value: "9000" } })
    fireEvent.change(screen.getByLabelText("maxConcurrentCalls"), { target: { value: "2" } })
    fireEvent.click(screen.getByRole("switch"))

    jest.useFakeTimers()
    try {
      fireEvent.click(screen.getByRole("button", { name: "save" }))
      // Flush the async save (microtasks only — no timers involved).
      await act(async () => {
        await Promise.resolve()
      })
      expect(setSettingsMock).toHaveBeenCalledWith("demo", {
        interpreterPath: "D:/py/python.exe",
        env: undefined,
        callTimeoutMs: 9000,
        useVenv: false,
        idleShutdownMin: undefined,
        maxConcurrentCalls: 2,
        maxOutboundHostCalls: undefined,
        installer: undefined,
        venvScope: undefined,
      })
      expect(screen.getByRole("status")).toHaveTextContent("saved")
      act(() => {
        jest.advanceTimersByTime(2100)
      })
      expect(screen.queryByRole("status")).not.toBeInTheDocument()
    } finally {
      jest.useRealTimers()
    }
  })

  it("parses multi-line env input on save", async () => {
    await renderLoaded()
    fireEvent.change(screen.getByLabelText("env"), {
      target: { value: "A=1\nB=two=parts\n\n" },
    })
    fireEvent.click(screen.getByRole("button", { name: "save" }))
    await waitFor(() =>
      expect(setSettingsMock).toHaveBeenCalledWith(
        "demo",
        expect.objectContaining({ env: { A: "1", B: "two=parts" } })
      )
    )
  })

  it("blocks save and shows an error on invalid env lines", async () => {
    await renderLoaded()
    fireEvent.change(screen.getByLabelText("env"), { target: { value: "not a pair" } })
    expect(screen.getByText("envInvalid")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "save" })).toBeDisabled()
    expect(setSettingsMock).not.toHaveBeenCalled()
  })

  it("hides the deps block when the manifest declares none", async () => {
    await renderLoaded([])
    expect(screen.queryByRole("button", { name: /deps\.install/ })).not.toBeInTheDocument()
  })

  it("installs deps only after the confirm dialog is accepted", async () => {
    const user = userEvent.setup()
    await renderLoaded(["requests>=2", "numpy"])

    await user.click(screen.getByRole("button", { name: /deps\.install/ }))
    // Dialog open — nothing installed yet.
    expect(installDepsMock).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "deps.confirm" }))
    await waitFor(() =>
      expect(installDepsMock).toHaveBeenCalledWith("demo", ["requests>=2", "numpy"])
    )
  })

  it("surfaces install failures inline", async () => {
    installDepsMock.mockRejectedValue(new Error("pip exploded"))
    const user = userEvent.setup()
    await renderLoaded(["requests"])

    await user.click(screen.getByRole("button", { name: /deps\.install/ }))
    await user.click(screen.getByRole("button", { name: "deps.confirm" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("pip exploded")
  })

  it("loads the persisted installer, scope and outbound gate", async () => {
    getSettingsMock.mockResolvedValue({
      maxOutboundHostCalls: 16,
      installer: { kind: "custom", path: "/usr/bin/pdm", installArgs: ["add", "{specs}"] },
      venvScope: "isolated",
    })
    await renderLoaded()

    expect(screen.getByLabelText("maxOutboundHostCalls")).toHaveValue(16)
    expect(screen.getByLabelText("environment.installer")).toHaveTextContent(
      "environment.installerCustom"
    )
    expect(screen.getByLabelText("environment.scope")).toHaveTextContent(
      "environment.scopeIsolated"
    )
    expect(screen.getByLabelText("environment.installerPath")).toHaveValue("/usr/bin/pdm")
    expect(screen.getByLabelText("environment.installArgs")).toHaveValue("add\n{specs}")
    // Loaded, not changed — no rebuild warning yet.
    expect(screen.queryByTestId("installer-switch-warning")).not.toBeInTheDocument()
  })

  it("persists the installer choice and the outbound gate", async () => {
    const user = userEvent.setup()
    await renderLoaded()

    await user.click(screen.getByLabelText("environment.installer"))
    await user.click(await screen.findByRole("option", { name: "environment.installerUv" }))
    fireEvent.change(screen.getByLabelText("maxOutboundHostCalls"), { target: { value: "16" } })

    await user.click(screen.getByRole("button", { name: "save" }))
    await waitFor(() =>
      expect(setSettingsMock).toHaveBeenCalledWith(
        "demo",
        expect.objectContaining({
          maxOutboundHostCalls: 16,
          installer: {
            kind: "uv",
            path: undefined,
            createArgs: undefined,
            installArgs: undefined,
          },
        })
      )
    )
  })

  it("warns that switching the installer rebuilds the environment, and clears it on save", async () => {
    const user = userEvent.setup()
    await renderLoaded()

    await user.click(screen.getByLabelText("environment.installer"))
    await user.click(await screen.findByRole("option", { name: "environment.installerPip" }))
    expect(screen.getByTestId("installer-switch-warning")).toBeInTheDocument()
    expect(screen.getByLabelText("environment.installer")).toHaveAttribute("aria-describedby")

    await user.click(screen.getByRole("button", { name: "save" }))
    await waitFor(() =>
      expect(screen.queryByTestId("installer-switch-warning")).not.toBeInTheDocument()
    )
  })

  it("blocks save when a custom installer has no executable or install argv", async () => {
    const user = userEvent.setup()
    await renderLoaded()

    await user.click(screen.getByLabelText("environment.installer"))
    await user.click(await screen.findByRole("option", { name: "environment.installerCustom" }))

    expect(screen.getByText("environment.customIncomplete")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "save" })).toBeDisabled()

    fireEvent.change(screen.getByLabelText("environment.installerPath"), {
      target: { value: "/usr/bin/pdm" },
    })
    // Still incomplete: an executable with nothing to run installs nothing.
    expect(screen.getByRole("button", { name: "save" })).toBeDisabled()

    fireEvent.change(screen.getByLabelText("environment.installArgs"), {
      target: { value: "add\n{specs}\n\n" },
    })
    expect(screen.getByRole("button", { name: "save" })).toBeEnabled()

    await user.click(screen.getByRole("button", { name: "save" }))
    await waitFor(() =>
      expect(setSettingsMock).toHaveBeenCalledWith(
        "demo",
        expect.objectContaining({
          installer: expect.objectContaining({
            kind: "custom",
            path: "/usr/bin/pdm",
            installArgs: ["add", "{specs}"],
          }),
        })
      )
    )
  })

  it("keeps a template argument that contains spaces as one argv element", async () => {
    const user = userEvent.setup()
    await renderLoaded()

    await user.click(screen.getByLabelText("environment.installer"))
    await user.click(await screen.findByRole("option", { name: "environment.installerCustom" }))
    fireEvent.change(screen.getByLabelText("environment.installerPath"), {
      target: { value: "C:/Program Files/pdm/pdm.exe" },
    })
    fireEvent.change(screen.getByLabelText("environment.installArgs"), {
      target: { value: "add\n--project\nC:/My Projects/app\n{specs}" },
    })
    await user.click(screen.getByRole("button", { name: "save" }))

    await waitFor(() =>
      expect(setSettingsMock).toHaveBeenCalledWith(
        "demo",
        expect.objectContaining({
          installer: expect.objectContaining({
            installArgs: ["add", "--project", "C:/My Projects/app", "{specs}"],
          }),
        })
      )
    )
  })

  it("hides the runtime strip when there is no native host", async () => {
    await renderLoaded()
    expect(screen.queryByText(/environment\.uv/)).not.toBeInTheDocument()
  })

  it("offers the guided uv install only when uv is missing", async () => {
    runtimeInfoMock.mockResolvedValue({ available: true, version: "3.12.1", uv_version: null })
    const user = userEvent.setup()
    await renderLoaded()

    expect(await screen.findByText("environment.uvMissing")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "environment.uvInstall" }))

    await waitFor(() => expect(installUvMock).toHaveBeenCalled())
    // The reported version replaces the offer — no reload needed to see it.
    expect(
      await screen.findByText('environment.uvPresent:{"version":"uv 0.5.0"}')
    ).toBeInTheDocument()
  })

  it("does not offer the uv install when uv is already on PATH", async () => {
    runtimeInfoMock.mockResolvedValue({
      available: true,
      version: "3.12.1",
      uv_version: "0.4.9",
    })
    await renderLoaded()

    expect(await screen.findByText('environment.uvPresent:{"version":"0.4.9"}')).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "environment.uvInstall" })).not.toBeInTheDocument()
  })

  it("surfaces a failed uv install without claiming uv is present", async () => {
    runtimeInfoMock.mockResolvedValue({ available: true, version: "3.12.1", uv_version: null })
    installUvMock.mockRejectedValue(new Error("no network"))
    const user = userEvent.setup()
    await renderLoaded()

    await user.click(await screen.findByRole("button", { name: "environment.uvInstall" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("no network")
    expect(screen.getByText("environment.uvMissing")).toBeInTheDocument()
  })

  it("reports where the install landed, and why it was not shared", async () => {
    installDepsMock.mockResolvedValue({
      venvDir: "/data/venvs/repowiki",
      scope: "isolated",
      installer: "uv",
      downgradedReason: "numpy<2 conflicts with an existing contributor",
    })
    const user = userEvent.setup()
    await renderLoaded(["numpy<2"])

    await user.click(screen.getByRole("button", { name: /deps\.install/ }))
    await user.click(screen.getByRole("button", { name: "deps.confirm" }))

    const outcome = await screen.findByTestId("py-install-outcome")
    expect(outcome).toHaveTextContent("/data/venvs/repowiki")
    expect(outcome).toHaveTextContent('deps.outcome:{"installer":"uv","scope":"isolated"}')
    expect(outcome).toHaveTextContent(
      'deps.downgraded:{"reason":"numpy<2 conflicts with an existing contributor"}'
    )
  })

  it("omits the downgrade line when the shared environment was honoured", async () => {
    installDepsMock.mockResolvedValue({
      venvDir: "/data/venvs/_shared/py312",
      scope: "shared",
      installer: "uv",
      downgradedReason: null,
    })
    const user = userEvent.setup()
    await renderLoaded(["requests"])

    await user.click(screen.getByRole("button", { name: /deps\.install/ }))
    await user.click(screen.getByRole("button", { name: "deps.confirm" }))

    const outcome = await screen.findByTestId("py-install-outcome")
    expect(outcome).toHaveTextContent("/data/venvs/_shared/py312")
    expect(outcome.textContent).not.toContain("deps.downgraded")
  })
})
