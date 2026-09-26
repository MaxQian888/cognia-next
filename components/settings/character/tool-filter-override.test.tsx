/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/lib/tools/tool-catalog", () => ({
  getToolCatalog: jest.fn(async () => [
    { id: "Bash", name: "Bash", source: "builtin", enabled: true },
    { id: "github", name: "github", source: "mcp", enabled: true },
  ]),
  searchToolCatalog: (entries: unknown[]) => entries,
}))

import { useState } from "react"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ToolFilterConfig } from "@cognia/agent-config-types"

import { ToolFilterOverride } from "./tool-filter-override"

function Harness({
  initial,
  onChange,
}: {
  initial: ToolFilterConfig | undefined
  onChange: (next: ToolFilterConfig | undefined) => void
}) {
  const [value, setValue] = useState(initial)
  return (
    <ToolFilterOverride
      value={value}
      onChange={(next) => {
        setValue(next)
        onChange(next)
      }}
    />
  )
}

describe("ToolFilterOverride", () => {
  it("inherits while unset and shows no catalog", () => {
    render(<Harness initial={undefined} onChange={jest.fn()} />)
    expect(screen.getByRole("combobox", { name: "label" })).toHaveTextContent("inherit")
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument()
  })

  it("writes a whole filter when a mode is chosen, then routes picks by source", async () => {
    const user = userEvent.setup()
    const onChange = jest.fn()
    render(<Harness initial={undefined} onChange={onChange} />)
    await user.click(screen.getByRole("combobox", { name: "label" }))
    await user.click(screen.getByRole("option", { name: "mode_deny" }))
    expect(onChange).toHaveBeenLastCalledWith({ mode: "deny" })

    const boxes = await screen.findAllByRole("checkbox", { name: "toggleTool" })
    await user.click(boxes[0]!)
    expect(onChange).toHaveBeenLastCalledWith({ mode: "deny", tools: ["Bash"] })
    await user.click(screen.getAllByRole("checkbox", { name: "toggleTool" })[1]!)
    expect(onChange).toHaveBeenLastCalledWith({
      mode: "deny",
      tools: ["Bash"],
      mcpServerIds: ["github"],
    })
  })

  it("keeps the selection across a mode change and clears it on inherit", async () => {
    const user = userEvent.setup()
    const onChange = jest.fn()
    render(<Harness initial={{ mode: "allow", tools: ["Bash"] }} onChange={onChange} />)
    await user.click(screen.getByRole("combobox", { name: "label" }))
    await user.click(screen.getByRole("option", { name: "mode_deny" }))
    expect(onChange).toHaveBeenLastCalledWith({ mode: "deny", tools: ["Bash"] })

    await user.click(screen.getByRole("combobox", { name: "label" }))
    await user.click(screen.getByRole("option", { name: "inherit" }))
    expect(onChange).toHaveBeenLastCalledWith(undefined)
  })
})
