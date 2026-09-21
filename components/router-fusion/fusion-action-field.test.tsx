/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { AppSettings } from "@cognia/agent-config-types"

import { useProjectStore } from "@/stores/project/project-store"
import { useSettingsStore } from "@/stores/settings"

import { FusionActionField } from "./fusion-action-field"

function setSettings(routerFusion: unknown): void {
  useSettingsStore.setState({ settings: { routerFusion } as unknown as AppSettings })
}

beforeEach(() => {
  setSettings({ enabled: true, surfaces: { agentsWorkflows: true } })
  useProjectStore.setState({ activeProjectId: "project-1" })
})

describe("FusionActionField", () => {
  it("defaults to Auto and offers the wired modes", async () => {
    render(<FusionActionField id="f" value={undefined} onChange={jest.fn()} />)
    expect(screen.getByTestId("fusion-action-trigger")).toHaveTextContent("Auto")
    await userEvent.click(screen.getByTestId("fusion-action-trigger"))
    expect(screen.getByRole("option", { name: /Direct/ })).toBeEnabled()
    expect(screen.getByRole("option", { name: /Cascade/ })).toBeEnabled()
    expect(screen.getByRole("option", { name: /Panel/ })).toBeEnabled()
  })

  it("offers delegate when there is a workspace to edit", async () => {
    render(<FusionActionField id="f" value="auto" onChange={jest.fn()} />)
    await userEvent.click(screen.getByTestId("fusion-action-trigger"))
    const delegate = screen.getByRole("option", { name: /Delegate/ })
    expect(delegate).not.toHaveTextContent("Later release")
    expect(delegate).toBeEnabled()
  })

  it("disables delegate, with the reason, when there is no workspace", async () => {
    useProjectStore.setState({ activeProjectId: null })
    render(<FusionActionField id="f" value="delegate" onChange={jest.fn()} />)
    expect(screen.getByRole("alert")).toHaveTextContent(/needs a workspace/)
    await userEvent.click(screen.getByTestId("fusion-action-trigger"))
    expect(screen.getByRole("option", { name: /Delegate/ })).toHaveAttribute(
      "aria-disabled",
      "true"
    )
    // The modes that need no workspace stay available.
    expect(screen.getByRole("option", { name: /Cascade/ })).toBeEnabled()
  })

  it("reports the chosen mode back as a valid action choice", async () => {
    const onChange = jest.fn()
    render(<FusionActionField id="f" value="auto" onChange={onChange} />)
    await userEvent.click(screen.getByTestId("fusion-action-trigger"))
    await userEvent.click(screen.getByRole("option", { name: /Cascade/ }))
    expect(onChange).toHaveBeenCalledWith("cascade")
  })

  it("disables every mode and explains why while the surface is off", async () => {
    setSettings({ enabled: true, surfaces: { agentsWorkflows: false } })
    render(<FusionActionField id="f" value="cascade" onChange={jest.fn()} />)
    expect(screen.getByRole("alert")).toHaveTextContent(/Router \+ Fusion is off/)
    await userEvent.click(screen.getByTestId("fusion-action-trigger"))
    expect(screen.getByRole("option", { name: /Panel/ })).toHaveAttribute("aria-disabled", "true")
    expect(screen.getByRole("option", { name: /Auto/ })).not.toHaveAttribute("aria-disabled")
  })

  it("says nothing is wrong about a mode the account can run", () => {
    render(<FusionActionField id="f" value="panel" onChange={jest.fn()} />)
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("takes the workspace from the caller when it names one", () => {
    useProjectStore.setState({ activeProjectId: null })
    const { rerender } = render(
      <FusionActionField id="f" value="panel" onChange={jest.fn()} hasWorkspace />
    )
    expect(screen.queryByRole("alert")).toBeNull()
    rerender(<FusionActionField id="f" value="panel" onChange={jest.fn()} hasWorkspace={false} />)
    // `panel` needs no workspace, so neither reading refuses it.
    expect(screen.queryByRole("alert")).toBeNull()
  })
})
