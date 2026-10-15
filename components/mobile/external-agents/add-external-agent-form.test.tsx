/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react"

import { AddExternalAgentForm } from "./add-external-agent-form"

const mockReplace = jest.fn()
const mockPush = jest.fn()
const mockCreateForm = jest.fn()

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace, push: mockPush }),
}))

jest.mock("@/components/agent/external-agent/host/host-agent-create-form", () => ({
  HostAgentCreateForm: (props: {
    presetId: string
    onCreated: (configId: string) => void
    onCancel: () => void
  }) => {
    mockCreateForm(props)
    return (
      <>
        <button onClick={() => props.onCreated("eac_created")}>Create</button>
        <button onClick={props.onCancel}>Cancel</button>
      </>
    )
  },
}))

beforeEach(() => jest.clearAllMocks())

describe("AddExternalAgentForm", () => {
  it("passes the selected preset to the shared Host form", () => {
    render(<AddExternalAgentForm presetId="claude-code" />)
    expect(mockCreateForm).toHaveBeenCalledWith(
      expect.objectContaining({ presetId: "claude-code" })
    )
  })

  it("replaces the configure route with the list after creation", () => {
    render(<AddExternalAgentForm presetId="claude-code" />)
    fireEvent.click(screen.getByRole("button", { name: "Create" }))
    expect(mockReplace).toHaveBeenCalledWith("/me/external-agents")
    expect(mockPush).not.toHaveBeenCalled()
  })

  it("returns to the preset picker when the form is cancelled", () => {
    render(<AddExternalAgentForm presetId="custom" />)
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(mockPush).toHaveBeenCalledWith("/me/external-agents/new")
    expect(mockReplace).not.toHaveBeenCalled()
  })
})
