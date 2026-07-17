/**
 * @jest-environment jsdom
 */

import * as ReactForMock from "react"
import { fireEvent, render } from "@testing-library/react"

import { ToolActivityGroup, type ToolActivityGroupEntry } from "./tool-activity-group"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))

// Default to the reduced-motion branch so the body renders synchronously
// without AnimatePresence wrappers — deterministic. Individual tests can flip
// `mockMotion.reduce` to exercise the animated path.
const mockMotion = { reduce: true, speed: 1 }
jest.mock("@/components/chat/motion/motion-reveal", () => ({
  useFlowMotion: () => mockMotion,
  MotionCollapse: ({ open, children }: { open: boolean; children: unknown }) =>
    open ? ReactForMock.createElement("div", null, children as never) : null,
  MotionStatusSwap: ({ children }: { children: unknown }) =>
    ReactForMock.createElement(ReactForMock.Fragment, null, children as never),
}))

afterEach(() => {
  mockMotion.reduce = true
})

jest.mock("./tool-call-row", () => ({
  ToolCallRow: ({
    part,
    expanded,
    onToggle,
  }: {
    part: { type: string }
    expanded?: boolean
    onToggle?: () => void
  }) =>
    ReactForMock.createElement(
      "button",
      { "data-testid": `row-${part.type}`, "data-expanded": String(expanded), onClick: onToggle },
      part.type
    ),
}))

function entry(type: string, state = "output-available"): ToolActivityGroupEntry {
  return { part: { type, state } as never, key: type }
}

const ROWS = [entry("tool-Read"), entry("tool-Grep"), entry("tool-Bash")]

describe("ToolActivityGroup", () => {
  it("summarizes the count and aggregate status", () => {
    const { getByTestId } = render(
      <ToolActivityGroup entries={ROWS} mode="standard" renderCard={() => null} />
    )
    const group = getByTestId("tool-activity-group")
    expect(group.getAttribute("data-status")).toBe("complete")
    expect(group.textContent).toContain("group.summary")
  })

  it("renders a per-type tally preview in the header", () => {
    const entries = [entry("tool-Read"), entry("tool-Read"), entry("tool-Grep")]
    const { getByTestId } = render(
      <ToolActivityGroup entries={entries} mode="standard" renderCard={() => null} />
    )
    const tally = getByTestId("tool-activity-group-tally")
    // Mocked t echoes `group.tally:{params}` — assert both buckets + counts.
    expect(tally.textContent).toContain('"name":"Read","count":2')
    expect(tally.textContent).toContain('"name":"Grep","count":1')
  })

  it("renders a natural-language action summary in simplified mode (no count/tally)", () => {
    const entries = [entry("tool-Edit"), entry("tool-Bash"), entry("tool-Read")]
    const { getByTestId, queryByTestId } = render(
      <ToolActivityGroup entries={entries} mode="simplified" renderCard={() => null} />
    )
    const actions = getByTestId("tool-activity-group-actions")
    // Mocked t echoes `action.<category>:{params}` — assert each verb bucket.
    expect(actions.textContent).toContain("action.edit")
    expect(actions.textContent).toContain("action.run")
    expect(actions.textContent).toContain("action.read")
    // The count label + per-type tally are standard/detailed only.
    expect(queryByTestId("tool-activity-group-tally")).toBeNull()
  })

  it("marks running aggregate status", () => {
    const entries = [entry("tool-Read"), entry("tool-Grep", "input-available")]
    const { getByTestId } = render(
      <ToolActivityGroup entries={entries} mode="standard" renderCard={() => null} />
    )
    expect(getByTestId("tool-activity-group").getAttribute("data-status")).toBe("running")
  })

  it("simplified mode is collapsed by default and toggles open", () => {
    const { getByTestId, queryByTestId } = render(
      <ToolActivityGroup entries={ROWS} mode="simplified" renderCard={() => null} />
    )
    expect(queryByTestId("row-tool-Read")).toBeNull()
    fireEvent.click(getByTestId("tool-activity-group-toggle"))
    expect(getByTestId("row-tool-Read")).toBeTruthy()
  })

  it("standard mode is expanded by default and uses renderCard", () => {
    const renderCard = jest.fn((part: { type: string }, key: string) =>
      ReactForMock.createElement("div", { key, "data-testid": `card-${part.type}` }, part.type)
    )
    const { getByTestId } = render(
      <ToolActivityGroup entries={ROWS} mode="standard" renderCard={renderCard} />
    )
    expect(getByTestId("card-tool-Read")).toBeTruthy()
    expect(renderCard).toHaveBeenCalledTimes(3)
  })

  it("toggles a single row's expanded state in simplified mode", () => {
    const { getByTestId } = render(
      <ToolActivityGroup entries={ROWS} mode="simplified" renderCard={() => null} />
    )
    fireEvent.click(getByTestId("tool-activity-group-toggle")) // open group
    expect(getByTestId("row-tool-Read").getAttribute("data-expanded")).toBe("false")
    fireEvent.click(getByTestId("row-tool-Read"))
    expect(getByTestId("row-tool-Read").getAttribute("data-expanded")).toBe("true")
    fireEvent.click(getByTestId("row-tool-Read"))
    expect(getByTestId("row-tool-Read").getAttribute("data-expanded")).toBe("false")
  })

  it("expand-all toggles every row open in simplified mode", () => {
    const { getByTestId } = render(
      <ToolActivityGroup entries={ROWS} mode="simplified" renderCard={() => null} />
    )
    fireEvent.click(getByTestId("tool-activity-group-toggle")) // open group
    fireEvent.click(getByTestId("tool-activity-group-expand-all"))
    expect(getByTestId("row-tool-Read").getAttribute("data-expanded")).toBe("true")
    expect(getByTestId("row-tool-Bash").getAttribute("data-expanded")).toBe("true")
  })

  it("expand-all forces cards open via forceOpen in standard mode", () => {
    const seen: Array<boolean | undefined> = []
    const renderCard = (part: { type: string }, key: string, opts: { forceOpen?: boolean }) => {
      seen.push(opts.forceOpen)
      return ReactForMock.createElement("div", { key, "data-testid": `card-${part.type}` })
    }
    const { getByTestId } = render(
      <ToolActivityGroup entries={ROWS} mode="standard" renderCard={renderCard} />
    )
    seen.length = 0
    fireEvent.click(getByTestId("tool-activity-group-expand-all"))
    expect(seen).toContain(true)
  })

  it("detailed mode passes forceOpen=true to cards by default", () => {
    const seen: Array<boolean | undefined> = []
    const renderCard = (part: { type: string }, key: string, opts: { forceOpen?: boolean }) => {
      seen.push(opts.forceOpen)
      return ReactForMock.createElement("div", { key })
    }
    render(<ToolActivityGroup entries={ROWS} mode="detailed" renderCard={renderCard} />)
    expect(seen.every((v) => v === true)).toBe(true)
  })

  it("renders the animated (AnimatePresence) body when motion is enabled", () => {
    mockMotion.reduce = false
    const { getByTestId } = render(
      <ToolActivityGroup
        entries={ROWS}
        mode="standard"
        renderCard={(part, key) =>
          ReactForMock.createElement("div", { key, "data-testid": `card-${part.type}` })
        }
      />
    )
    expect(getByTestId("card-tool-Read")).toBeTruthy()
  })

  it("collapsing the group hides its body", () => {
    const { getByTestId, queryByTestId } = render(
      <ToolActivityGroup
        entries={ROWS}
        mode="standard"
        renderCard={(part, key) =>
          ReactForMock.createElement("div", { key, "data-testid": `card-${part.type}` })
        }
      />
    )
    expect(getByTestId("card-tool-Read")).toBeTruthy()
    fireEvent.click(getByTestId("tool-activity-group-toggle"))
    expect(queryByTestId("card-tool-Read")).toBeNull()
  })
})
