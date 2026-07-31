/**
 * @jest-environment jsdom
 */

import { useState } from "react"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { ToolScopeField, toolScopeMode, toolScopeValue } from "./tool-scope-field"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))
jest.mock("@/components/chat/motion/motion-reveal", () => ({
  useFlowMotion: () => ({ reduce: true, durationScale: 1 }),
}))
jest.mock("./tool-catalog-dialog", () => ({
  ToolCatalogDialog: ({
    open,
    onConfirm,
  }: {
    open: boolean
    onConfirm: (next: string[]) => void
  }) =>
    open ? (
      <button type="button" data-testid="stub-catalog" onClick={() => onConfirm(["Read", "Grep"])}>
        pick
      </button>
    ) : null,
}))

function Controlled({ initial }: { initial: string[] | undefined }) {
  const [value, setValue] = useState<string[] | undefined>(initial)
  return (
    <>
      <ToolScopeField label="tools" value={value} onChange={setValue} />
      <span data-testid="serialized">{JSON.stringify(value ?? null)}</span>
    </>
  )
}

describe("toolScopeMode", () => {
  it("distinguishes the three states that a multi-select would flatten", () => {
    expect(toolScopeMode(undefined)).toBe("inherit")
    expect(toolScopeMode([])).toBe("none")
    expect(toolScopeMode(["Read"])).toBe("custom")
  })
})

describe("toolScopeValue", () => {
  it("maps each mode to its distinct stored value", () => {
    expect(toolScopeValue("inherit", ["Read"])).toBeUndefined()
    expect(toolScopeValue("none", ["Read"])).toEqual([])
    expect(toolScopeValue("custom", ["Read"])).toEqual(["Read"])
  })

  it("returns a copy so the caller cannot alias the remembered list", () => {
    const remembered = ["Read"]
    const out = toolScopeValue("custom", remembered)
    expect(out).not.toBe(remembered)
  })
})

describe("ToolScopeField", () => {
  it("reflects inherit as the active mode for an absent value", () => {
    render(<Controlled initial={undefined} />)
    expect(screen.getByTestId("tool-scope-mode-inherit")).toHaveAttribute("aria-checked", "true")
  })

  it("writes undefined for inherit and [] for none — never conflating them", async () => {
    render(<Controlled initial={["Read"]} />)
    expect(screen.getByTestId("serialized")).toHaveTextContent('["Read"]')

    await userEvent.click(screen.getByTestId("tool-scope-mode-inherit"))
    expect(screen.getByTestId("serialized")).toHaveTextContent("null")

    await userEvent.click(screen.getByTestId("tool-scope-mode-none"))
    expect(screen.getByTestId("serialized")).toHaveTextContent("[]")
  })

  it("restores the previous list when returning to custom", async () => {
    render(<Controlled initial={["Read", "Grep"]} />)
    await userEvent.click(screen.getByTestId("tool-scope-mode-inherit"))
    await userEvent.click(screen.getByTestId("tool-scope-mode-custom"))
    expect(screen.getByTestId("serialized")).toHaveTextContent('["Read","Grep"]')
  })

  it("only shows the chip list in custom mode", async () => {
    render(<Controlled initial={["Read"]} />)
    expect(screen.getByTestId("tool-scope-chip-Read")).toBeInTheDocument()
    await userEvent.click(screen.getByTestId("tool-scope-mode-none"))
    expect(screen.queryByTestId("tool-scope-chip-Read")).not.toBeInTheDocument()
  })

  it("removing the last chip lands on an explicit empty custom list, not inherit", async () => {
    render(<Controlled initial={["Read"]} />)
    await userEvent.click(screen.getByLabelText("removeTool"))
    expect(screen.getByTestId("serialized")).toHaveTextContent("[]")
  })

  it("applies a catalog selection", async () => {
    render(<Controlled initial={["Read"]} />)
    await userEvent.click(screen.getByTestId("tool-scope-open-catalog"))
    await userEvent.click(screen.getByTestId("stub-catalog"))
    expect(screen.getByTestId("serialized")).toHaveTextContent('["Read","Grep"]')
  })

  it("exposes the segment as a radiogroup so it is announced as a choice", () => {
    render(<Controlled initial={undefined} />)
    expect(screen.getByRole("radiogroup", { name: "tools" })).toBeInTheDocument()
    expect(screen.getAllByRole("radio")).toHaveLength(3)
  })
})
