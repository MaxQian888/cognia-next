/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { AppSettings } from "@cognia/agent-config-types"

import { useProjectStore } from "@/stores/project/project-store"
import { useSettingsStore } from "@/stores/settings"
import type { Project } from "@/types"

import { FusionActionField } from "./fusion-action-field"

function setSettings(routerFusion: unknown): void {
  useSettingsStore.setState({ settings: { routerFusion } as unknown as AppSettings })
}

function project(id: string, root: string | null): Project {
  return {
    id,
    name: id,
    roots: root ? [{ path: root, isPrimary: true }] : [],
  } as unknown as Project
}

beforeEach(() => {
  setSettings({ enabled: true, surfaces: { agentsWorkflows: true } })
  useProjectStore.setState({
    activeProjectId: "project-1",
    projects: [project("project-1", "/repo/one"), project("project-empty", null)],
  })
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
    expect(screen.getByRole("alert")).toHaveTextContent(/needs a project with a folder/)
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

  it("does not count a project without a folder as a workspace", async () => {
    // The runtime asks the same thing of the same project: its primary root.
    useProjectStore.setState({ activeProjectId: "project-empty" })
    render(<FusionActionField id="f" value="delegate" onChange={jest.fn()} />)
    expect(screen.getByRole("alert")).toHaveTextContent(/needs a project with a folder/)
  })

  it("takes the project from the caller when it names one", () => {
    useProjectStore.setState({ activeProjectId: null })
    const { rerender } = render(
      <FusionActionField id="f" value="delegate" onChange={jest.fn()} projectId="project-1" />
    )
    expect(screen.queryByRole("alert")).toBeNull()
    // A caller with no project at all does not fall back to the active one.
    useProjectStore.setState({ activeProjectId: "project-1" })
    rerender(<FusionActionField id="f" value="delegate" onChange={jest.fn()} projectId={null} />)
    expect(screen.getByRole("alert")).toHaveTextContent(/needs a project with a folder/)
    // `panel` needs no workspace, so it is never refused for want of one.
    rerender(<FusionActionField id="f" value="panel" onChange={jest.fn()} projectId={null} />)
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("offers the delegate delivery only for delegate, defaulting to a patch", async () => {
    const onDeliveryChange = jest.fn()
    const { rerender } = render(
      <FusionActionField
        id="f"
        value="panel"
        onChange={jest.fn()}
        onDeliveryChange={onDeliveryChange}
      />
    )
    expect(screen.queryByTestId("fusion-delivery-trigger")).toBeNull()
    rerender(
      <FusionActionField
        id="f"
        value="delegate"
        onChange={jest.fn()}
        onDeliveryChange={onDeliveryChange}
      />
    )
    expect(screen.getByTestId("fusion-delivery-trigger")).toHaveTextContent("Patch only")
    await userEvent.click(screen.getByTestId("fusion-delivery-trigger"))
    await userEvent.click(screen.getByRole("option", { name: "Apply to workspace" }))
    expect(onDeliveryChange).toHaveBeenCalledWith("workspace_updated")
  })

  it("shows no delivery choice for a host that does not store one", () => {
    render(<FusionActionField id="f" value="delegate" onChange={jest.fn()} />)
    expect(screen.queryByTestId("fusion-delivery-trigger")).toBeNull()
  })
})
