/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { useState } from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { InstructionsConfig } from "@/lib/claude/instructions/types"

import { InstructionsOverride, parseExtraPaths } from "./instructions-override"

function Harness({
  initial,
  onChange,
}: {
  initial: InstructionsConfig | undefined
  onChange: (next: InstructionsConfig | undefined) => void
}) {
  const [value, setValue] = useState(initial)
  return (
    <InstructionsOverride
      value={value}
      onChange={(next) => {
        setValue(next)
        onChange(next)
      }}
    />
  )
}

describe("parseExtraPaths", () => {
  it("drops blank lines and returns undefined for nothing", () => {
    expect(parseExtraPaths(" a.md \n\n b/*.md ")).toEqual(["a.md", "b/*.md"])
    expect(parseExtraPaths("\n  \n")).toBeUndefined()
  })
})

describe("InstructionsOverride", () => {
  it("inherits while unset and hides the fields", () => {
    render(<Harness initial={undefined} onChange={jest.fn()} />)
    expect(screen.getByRole("combobox", { name: "label" })).toHaveTextContent("inherit")
    expect(screen.queryByLabelText("enabled")).not.toBeInTheDocument()
  })

  it("takes the config over from the built-in defaults", async () => {
    const user = userEvent.setup()
    const onChange = jest.fn()
    render(<Harness initial={undefined} onChange={onChange} />)
    await user.click(screen.getByRole("combobox", { name: "label" }))
    await user.click(screen.getByRole("option", { name: "override" }))
    expect(onChange).toHaveBeenLastCalledWith({})
    // Resolved defaults are what the controls show.
    expect(screen.getByLabelText("enabled")).toBeChecked()
    expect(screen.getByLabelText("loadProjectAgents")).toBeChecked()

    await user.click(screen.getByLabelText("loadProjectAgents"))
    expect(onChange).toHaveBeenLastCalledWith({ loadProjectAgents: false })
  })

  it("patches the stored config and keeps keys the form does not show", () => {
    const onChange = jest.fn()
    render(
      <Harness
        initial={{ enabled: true, fileNames: ["RULES.md"], maxFiles: 5 }}
        onChange={onChange}
      />
    )
    const extra = screen.getByLabelText("extraPaths")
    fireEvent.change(extra, { target: { value: "docs/a.md\nrules/*.md" } })
    fireEvent.blur(extra)
    expect(onChange).toHaveBeenLastCalledWith({
      enabled: true,
      fileNames: ["RULES.md"],
      maxFiles: 5,
      extraPaths: ["docs/a.md", "rules/*.md"],
    })
  })

  it("does not write when the extra paths blur unchanged", () => {
    const onChange = jest.fn()
    render(<Harness initial={{ extraPaths: ["a.md"] }} onChange={onChange} />)
    fireEvent.blur(screen.getByLabelText("extraPaths"))
    expect(onChange).not.toHaveBeenCalled()
  })

  it("returns to inherit with undefined", async () => {
    const user = userEvent.setup()
    const onChange = jest.fn()
    render(<Harness initial={{ enabled: false }} onChange={onChange} />)
    await user.click(screen.getByRole("combobox", { name: "label" }))
    await user.click(screen.getByRole("option", { name: "inherit" }))
    expect(onChange).toHaveBeenLastCalledWith(undefined)
  })
})
