/**
 * @jest-environment jsdom
 */
import { fireEvent, render } from "@testing-library/react"
import {
  SystemTerminalConfig,
  TerminalSessionOpenConfig,
  TerminalSessionRunConfig,
  TerminalSessionCloseConfig,
  TerminalScriptConfig,
  TerminalReadRecentConfig,
  TerminalWaitForExitConfig,
  TerminalCommandTriggerConfig,
} from "./terminal-forms"

describe("terminal-forms export surface", () => {
  it("exports its workflow inspector forms", () => {
    expect(
      [
        SystemTerminalConfig,
        TerminalSessionOpenConfig,
        TerminalSessionRunConfig,
        TerminalSessionCloseConfig,
        TerminalScriptConfig,
        TerminalReadRecentConfig,
        TerminalWaitForExitConfig,
        TerminalCommandTriggerConfig,
      ].every((form) => typeof form === "function")
    ).toBe(true)
  })
})

/**
 * All three command-running terminal kinds declare `args` and the executors
 * consume it — `action.system.terminal` and `action.terminal.session.run`
 * append it to the command line, `action.terminal.script` spreads it as argv.
 * None had a field, and a kind with a dedicated form has no raw-JSON fallback.
 */
describe.each([
  ["SystemTerminalConfig", SystemTerminalConfig],
  ["TerminalSessionRunConfig", TerminalSessionRunConfig],
  ["TerminalScriptConfig", TerminalScriptConfig],
] as const)("%s — arguments", (_name, Form) => {
  function argsBox(container: HTMLElement): HTMLTextAreaElement {
    const field = container.querySelector('[data-field="args"]')
    if (!field) throw new Error("no args field")
    return field.querySelector("textarea") as HTMLTextAreaElement
  }

  it("splits one argument per line and trims blanks", () => {
    const onChange = jest.fn()
    const { container } = render(<Form params={{}} onChange={onChange} />)
    fireEvent.change(argsBox(container), { target: { value: "--verbose\n\n  --out=dist  " } })
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ args: ["--verbose", "--out=dist"] })
    )
  })

  it("renders a stored list back one per line", () => {
    const { container } = render(<Form params={{ args: ["a", "b"] }} onChange={jest.fn()} />)
    expect(argsBox(container).value).toBe("a\nb")
  })

  it("drops the param when the box is emptied", () => {
    const onChange = jest.fn()
    const { container } = render(<Form params={{ args: ["a"] }} onChange={onChange} />)
    fireEvent.change(argsBox(container), { target: { value: "   " } })
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ args: undefined }))
  })
})
