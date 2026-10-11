/** @jest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react"
import { useState } from "react"
import { useProjectStore } from "@/stores/project/project-store"

jest.mock("@/lib/db/characters", () => ({
  listCharacters: async () => [{ id: "char-1", name: "Coding Assistant" }],
}))
jest.mock("@/hooks/data", () => ({
  useClientLiveQuery: () => [{ id: "char-1", name: "Coding Assistant" }],
}))

import { MemoryNamespacePicker, type MemoryNamespaceKind } from "./memory-namespace-picker"

function Harness({
  kind,
  initial = "",
  allowNone,
  onValue,
}: {
  kind: MemoryNamespaceKind
  initial?: string
  allowNone?: boolean
  onValue?: (value: string) => void
}) {
  const [value, setValue] = useState(initial)
  return (
    <MemoryNamespacePicker
      kind={kind}
      label="Target"
      value={value}
      allowNone={allowNone}
      onChange={(next) => {
        setValue(next)
        onValue?.(next)
      }}
    />
  )
}

beforeEach(() => {
  useProjectStore.setState({ projects: [{ id: "p1", name: "Cognia" }] as never })
})

describe("MemoryNamespacePicker", () => {
  it("lists workspaces by name", () => {
    const onValue = jest.fn()
    render(<Harness kind="workspace" onValue={onValue} />)
    fireEvent.click(screen.getByLabelText("Target"))
    fireEvent.click(screen.getByRole("option", { name: "Cognia" }))
    expect(onValue).toHaveBeenLastCalledWith("p1")
  })

  it("lists characters for character and agent namespaces", () => {
    const onValue = jest.fn()
    render(<Harness kind="agent" onValue={onValue} />)
    fireEvent.click(screen.getByLabelText("Target"))
    fireEvent.click(screen.getByRole("option", { name: "Coding Assistant" }))
    expect(onValue).toHaveBeenLastCalledWith("char-1")
  })

  it("shows an id nothing here names as itself instead of dropping it", () => {
    render(<Harness kind="workspace" initial="deleted-project" />)
    expect(screen.getByLabelText("Target")).toHaveTextContent("deleted-project (not found)")
  })

  it("lets any other id be typed", () => {
    const onValue = jest.fn()
    render(<Harness kind="character" onValue={onValue} />)
    fireEvent.click(screen.getByLabelText("Target"))
    fireEvent.click(screen.getByRole("option", { name: "Other ID…" }))
    fireEvent.change(screen.getByLabelText("Custom ID for Target"), {
      target: { value: "external-agent" },
    })
    expect(onValue).toHaveBeenLastCalledWith("external-agent")
  })

  it("offers None for an optional layer", () => {
    const onValue = jest.fn()
    render(<Harness kind="workspace" initial="p1" allowNone onValue={onValue} />)
    fireEvent.click(screen.getByLabelText("Target"))
    fireEvent.click(screen.getByRole("option", { name: "None" }))
    expect(onValue).toHaveBeenLastCalledWith("")
  })
})
