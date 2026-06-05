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
jest.mock("@/lib/plugin/core/manager", () => ({
  getPluginManager: jest.fn(() => ({ installPythonDeps: installDepsMock })),
}))

import { PluginPythonHostSettings } from "./plugin-python-host-settings"

describe("PluginPythonHostSettings", () => {
  beforeEach(() => {
    getSettingsMock.mockReset()
    setSettingsMock.mockReset()
    installDepsMock.mockReset()
    getSettingsMock.mockResolvedValue(undefined)
    setSettingsMock.mockResolvedValue(undefined)
    installDepsMock.mockResolvedValue(undefined)
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
})
