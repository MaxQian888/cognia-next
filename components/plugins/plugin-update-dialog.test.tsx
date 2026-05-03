/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    if (vars && typeof vars.count === "number") return `${key}:${vars.count}`
    return key
  },
}))

import { PluginUpdateDialog, __resetPluginUpdateClientForTests } from "./plugin-update-dialog"

beforeEach(() => {
  __resetPluginUpdateClientForTests(null)
})

function makeClient(
  updates: Array<{
    pluginId: string
    fromVersion: string
    toVersion: string
  }> = []
) {
  return {
    checkForUpdates: jest.fn(async () => updates),
    installUpdate: jest.fn(async () => undefined),
    cancelUpdate: jest.fn(),
    onProgress: jest.fn(() => () => undefined),
  }
}

describe("PluginUpdateDialog", () => {
  it("shows the up-to-date message when no updates are available", async () => {
    const client = makeClient([])
    __resetPluginUpdateClientForTests(client)
    render(<PluginUpdateDialog open onClose={() => {}} />)
    await waitFor(() => expect(client.checkForUpdates).toHaveBeenCalled())
    expect(screen.getByText("upToDate")).toBeInTheDocument()
  })

  it("renders update entries returned by the client", async () => {
    const client = makeClient([
      { pluginId: "alpha", fromVersion: "1.0.0", toVersion: "1.1.0" },
      { pluginId: "beta", fromVersion: "0.5.0", toVersion: "0.6.0" },
    ])
    __resetPluginUpdateClientForTests(client)
    render(<PluginUpdateDialog open onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText("alpha")).toBeInTheDocument())
    expect(screen.getByText("beta")).toBeInTheDocument()
    expect(screen.getByText("availableCount:2")).toBeInTheDocument()
  })

  it("install-all calls installUpdate for every entry", async () => {
    const client = makeClient([{ pluginId: "alpha", fromVersion: "1.0.0", toVersion: "1.1.0" }])
    __resetPluginUpdateClientForTests(client)
    render(<PluginUpdateDialog open onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText("alpha")).toBeInTheDocument())
    fireEvent.click(screen.getByText("installAll"))
    await waitFor(() => expect(client.installUpdate).toHaveBeenCalledWith("alpha", "1.1.0"))
  })

  it("close button invokes onClose", () => {
    __resetPluginUpdateClientForTests(makeClient([]))
    const onClose = jest.fn()
    render(<PluginUpdateDialog open onClose={onClose} />)
    fireEvent.click(screen.getByText("close"))
    expect(onClose).toHaveBeenCalled()
  })
})
