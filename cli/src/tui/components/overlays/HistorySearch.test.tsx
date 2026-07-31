import React from "react"
import { render } from "@testing-library/react"
import { __fireInput, __resetInk } from "ink"

import { HistorySearch } from "./HistorySearch"

describe("HistorySearch", () => {
  beforeEach(() => __resetInk())

  const noop = () => {}

  it("renders the reverse-i-search prompt with the query and match", () => {
    const { container } = render(
      <HistorySearch
        query="ls"
        match="ls -la /work"
        onChar={noop}
        onBackspace={noop}
        onNext={noop}
        onAccept={noop}
        onCancel={noop}
      />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("(reverse-i-search)`ls':")
    expect(text).toContain("ls -la /work")
  })

  it("shows a no-match hint when nothing matches", () => {
    const { container } = render(
      <HistorySearch
        query="zzz"
        match={null}
        onChar={noop}
        onBackspace={noop}
        onNext={noop}
        onAccept={noop}
        onCancel={noop}
      />
    )
    expect(container.textContent).toContain("(no match)")
  })

  it("refines the query as the user types", () => {
    const onChar = jest.fn()
    render(
      <HistorySearch
        query=""
        match={null}
        onChar={onChar}
        onBackspace={noop}
        onNext={noop}
        onAccept={noop}
        onCancel={noop}
      />
    )
    __fireInput("g")
    expect(onChar).toHaveBeenCalledWith("g")
  })

  it("backspaces, cycles older, accepts, and cancels via the right keys", () => {
    const onBackspace = jest.fn()
    const onNext = jest.fn()
    const onAccept = jest.fn()
    const onCancel = jest.fn()
    render(
      <HistorySearch
        query="a"
        match="abc"
        onChar={noop}
        onBackspace={onBackspace}
        onNext={onNext}
        onAccept={onAccept}
        onCancel={onCancel}
      />
    )
    __fireInput("", { backspace: true })
    expect(onBackspace).toHaveBeenCalled()
    __fireInput("r", { ctrl: true })
    expect(onNext).toHaveBeenCalled()
    __fireInput("", { return: true })
    expect(onAccept).toHaveBeenCalled()
    __fireInput("", { escape: true })
    expect(onCancel).toHaveBeenCalled()
  })

  it("ignores unrelated control chords so they don't pollute the query", () => {
    const onChar = jest.fn()
    render(
      <HistorySearch
        query=""
        match={null}
        onChar={onChar}
        onBackspace={noop}
        onNext={noop}
        onAccept={noop}
        onCancel={noop}
      />
    )
    __fireInput("x", { ctrl: true })
    expect(onChar).not.toHaveBeenCalled()
  })
})
