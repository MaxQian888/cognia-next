import path from "node:path"
import React from "react"
import { act, render } from "@testing-library/react"
import { __fireInput, __resetInk } from "ink"

import { StartupGate } from "./StartupGate"

const CWD = path.resolve("/repo/project")

/** Fire a key and flush the resulting state update + effect re-registration. */
function key(opts: Record<string, boolean>) {
  act(() => __fireInput("", opts))
}

describe("StartupGate", () => {
  beforeEach(() => __resetInk())

  it("asks the trust question with the two choices", () => {
    const { container } = render(
      <StartupGate cwd={CWD} onTrust={() => {}} onChangeCwd={() => {}} />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("Do you trust the files")
    expect(text).toContain("Yes, proceed")
    expect(text).toContain("Choose another folder")
  })

  it("trusts on the first choice", () => {
    const onTrust = jest.fn()
    render(<StartupGate cwd={CWD} onTrust={onTrust} onChangeCwd={() => {}} />)
    key({ return: true })
    expect(onTrust).toHaveBeenCalled()
  })

  it("opens the folder picker on the second choice", () => {
    const { container } = render(
      <StartupGate cwd={CWD} onTrust={() => {}} onChangeCwd={() => {}} listDirs={() => ["sub"]} />
    )
    key({ downArrow: true })
    key({ return: true })
    const text = container.textContent ?? ""
    expect(text).toContain("Choose a folder")
    expect(text).toContain("sub/")
  })

  it("changes cwd when a folder is confirmed in the picker", () => {
    const onChangeCwd = jest.fn()
    render(
      <StartupGate cwd={CWD} onTrust={() => {}} onChangeCwd={onChangeCwd} listDirs={() => []} />
    )
    key({ downArrow: true }) // highlight "Choose another folder…"
    key({ return: true }) // open picker
    key({ return: true }) // confirm current folder (row 0)
    expect(onChangeCwd).toHaveBeenCalledWith(CWD)
  })

  it("returns to the trust gate on Escape from the picker", () => {
    const { container } = render(
      <StartupGate cwd={CWD} onTrust={() => {}} onChangeCwd={() => {}} listDirs={() => []} />
    )
    key({ downArrow: true })
    key({ return: true }) // open picker
    key({ escape: true }) // back to gate
    expect(container.textContent ?? "").toContain("Do you trust the files")
  })
})
