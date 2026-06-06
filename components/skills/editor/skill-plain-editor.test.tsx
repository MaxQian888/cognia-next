/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"
import { SkillPlainEditor } from "./skill-plain-editor"

describe("SkillPlainEditor", () => {
  it("renders the value and propagates edits through onChange", () => {
    const onChange = jest.fn()
    render(<SkillPlainEditor value="# hello" language="markdown" onChange={onChange} />)
    const area = screen.getByTestId("skill-plain-editor")
    expect(area).toHaveValue("# hello")
    fireEvent.change(area, { target: { value: "# hello world" } })
    expect(onChange).toHaveBeenCalledWith("# hello world")
  })

  it("disables autocorrect/spellcheck for code editing", () => {
    render(<SkillPlainEditor value="" language="shell" onChange={() => undefined} />)
    const area = screen.getByTestId("skill-plain-editor")
    expect(area).toHaveAttribute("spellcheck", "false")
    expect(area).toHaveAttribute("autocapitalize", "off")
    expect(area).toHaveAttribute("autocorrect", "off")
  })
})
