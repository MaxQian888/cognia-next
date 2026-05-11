/**
 * @jest-environment jsdom
 */

jest.mock("@monaco-editor/react", () => ({
  __esModule: true,
  default: ({
    value,
    onChange,
    language,
  }: {
    value: string
    onChange: (v: string | undefined) => void
    language: string
  }) => (
    <textarea
      data-testid="monaco-mock"
      data-language={language}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
  loader: { config: jest.fn() },
}))

jest.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "dark" }),
}))

jest.mock("@/lib/canvas/monaco-loader", () => ({
  configureMonacoLoader: jest.fn(),
}))

import { fireEvent, render, screen } from "@testing-library/react"
import { SkillMonacoEditor } from "./skill-monaco-editor"

describe("SkillMonacoEditor", () => {
  it("renders Monaco with the requested language", () => {
    render(<SkillMonacoEditor value="body" language="markdown" onChange={jest.fn()} />)
    expect(screen.getByTestId("monaco-mock")).toHaveAttribute("data-language", "markdown")
  })

  it("forwards changes to onChange", () => {
    const onChange = jest.fn()
    render(<SkillMonacoEditor value="body" language="markdown" onChange={onChange} />)
    fireEvent.change(screen.getByTestId("monaco-mock"), { target: { value: "edited" } })
    expect(onChange).toHaveBeenCalledWith("edited")
  })
})
