/**
 * @jest-environment jsdom
 */

import * as ReactForMock from "react"
import { fireEvent, render } from "@testing-library/react"

import {
  ToolActivityGroup,
  type ToolActivityChildOptions,
  type ToolActivityGroupEntry,
} from "./tool-activity-group"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))

// Default to the reduced-motion branch so the body renders synchronously
// without AnimatePresence wrappers — deterministic. Individual tests can flip
// `mockMotion.reduce` to exercise the animated path.
const mockMotion = { reduce: true, durationScale: 1 }
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

let keySeq = 0
function entry(type: string, state = "output-available"): ToolActivityGroupEntry {
  return { part: { type, state } as never, key: `${type}-${keySeq++}` }
}

/**
 * Stand-in for whatever the caller renders per child. Mirrors both open-state
 * channels the group drives: controlled (`expanded`/`onToggle`) and
 * seeded-at-mount (`forceOpen`).
 */
function renderRow(part: { type: string }, key: string, opts: ToolActivityChildOptions) {
  return ReactForMock.createElement(
    "button",
    {
      key,
      "data-testid": `row-${part.type}`,
      "data-expanded": String(opts.expanded),
      "data-force-open": String(opts.forceOpen),
      onClick: opts.onToggle,
    },
    part.type
  )
}

/** Distinct part types handed to `renderChild`, in first-seen order. */
function renderedTypes(spy: jest.Mock): string[] {
  const seen: string[] = []
  for (const [part] of spy.mock.calls as Array<[{ type: string }]>) {
    if (!seen.includes(part.type)) seen.push(part.type)
  }
  return seen
}

const ROWS = [entry("tool-Read"), entry("tool-Grep"), entry("tool-Bash")]

describe("ToolActivityGroup", () => {
  it("summarizes the count and aggregate status", () => {
    const { getByTestId } = render(
      <ToolActivityGroup entries={ROWS} mode="standard" renderChild={renderRow} />
    )
    const group = getByTestId("tool-activity-group")
    expect(group.getAttribute("data-status")).toBe("complete")
    expect(group.textContent).toContain("group.summary")
  })

  it("renders a per-type tally preview in the header", () => {
    const entries = [entry("tool-Read"), entry("tool-Read"), entry("tool-Grep")]
    const { getByTestId } = render(
      <ToolActivityGroup entries={entries} mode="standard" renderChild={renderRow} />
    )
    const tally = getByTestId("tool-activity-group-tally")
    // Mocked t echoes `group.tally:{params}` — assert both buckets + counts.
    expect(tally.textContent).toContain('"name":"Read","count":2')
    expect(tally.textContent).toContain('"name":"Grep","count":1')
  })

  it("renders a TUI-style count summary in simplified mode (no tool-count label/tally)", () => {
    const entries = [entry("tool-Read"), entry("tool-Read"), entry("tool-Grep")]
    const { getByTestId, queryByTestId } = render(
      <ToolActivityGroup entries={entries} mode="simplified" renderChild={renderRow} />
    )
    const actions = getByTestId("tool-activity-group-actions")
    // Mocked t echoes `count.<category>:{params}` — assert each count bucket.
    expect(actions.textContent).toContain('count.read:{"count":2}')
    expect(actions.textContent).toContain('count.search:{"count":1}')
    // The tool-call count label + per-type tally are standard/detailed only.
    expect(queryByTestId("tool-activity-group-tally")).toBeNull()
  })

  it("stays open in simplified mode while a child is still running", () => {
    const entries = [entry("tool-Read"), entry("tool-Grep", "input-available")]
    const { getByTestId } = render(
      <ToolActivityGroup entries={entries} mode="simplified" renderChild={renderRow} />
    )
    // Running → auto-open, so the rows render without a manual toggle.
    expect(getByTestId("row-tool-Read")).toBeTruthy()
  })

  it("stays open and shows an N-failed badge when a child errored (simplified)", () => {
    const entries = [entry("tool-Read", "output-error"), entry("tool-Grep")]
    const { getByTestId } = render(
      <ToolActivityGroup entries={entries} mode="simplified" renderChild={renderRow} />
    )
    expect(getByTestId("row-tool-Read")).toBeTruthy() // auto-open on error
    expect(getByTestId("tool-activity-group-failed").textContent).toContain('{"count":1}')
  })

  it("a manual toggle overrides the running auto-open (collapses live)", () => {
    const entries = [entry("tool-Read"), entry("tool-Grep", "input-available")]
    const { getByTestId, queryByTestId } = render(
      <ToolActivityGroup entries={entries} mode="simplified" renderChild={renderRow} />
    )
    expect(getByTestId("row-tool-Read")).toBeTruthy()
    fireEvent.click(getByTestId("tool-activity-group-toggle"))
    expect(queryByTestId("row-tool-Read")).toBeNull()
  })

  it("shows the N-failed badge in standard mode too", () => {
    const entries = [entry("tool-Read", "output-error"), entry("tool-Grep", "output-error")]
    const { getByTestId } = render(
      <ToolActivityGroup entries={entries} mode="standard" renderChild={renderRow} />
    )
    expect(getByTestId("tool-activity-group-failed").textContent).toContain('{"count":2}')
  })

  it("marks running aggregate status", () => {
    const entries = [entry("tool-Read"), entry("tool-Grep", "input-available")]
    const { getByTestId } = render(
      <ToolActivityGroup entries={entries} mode="standard" renderChild={renderRow} />
    )
    expect(getByTestId("tool-activity-group").getAttribute("data-status")).toBe("running")
  })

  it("simplified mode is collapsed by default and toggles open", () => {
    const { getByTestId, queryByTestId } = render(
      <ToolActivityGroup entries={ROWS} mode="simplified" renderChild={renderRow} />
    )
    expect(queryByTestId("row-tool-Read")).toBeNull()
    fireEvent.click(getByTestId("tool-activity-group-toggle"))
    expect(getByTestId("row-tool-Read")).toBeTruthy()
  })

  it("standard mode is expanded by default and renders every child", () => {
    const renderChild = jest.fn(renderRow)
    const { getByTestId } = render(
      <ToolActivityGroup entries={ROWS} mode="standard" renderChild={renderChild} />
    )
    expect(getByTestId("row-tool-Read")).toBeTruthy()
    expect(renderedTypes(renderChild)).toEqual(["tool-Read", "tool-Grep", "tool-Bash"])
  })

  // The group must never render children itself: the caller owns what a child
  // looks like (a compact row, a full card + its plugin action slot), and the
  // simplified path used to bypass it — silently dropping the per-call plugin
  // slot for every tool inside a group.
  it("routes children through renderChild in simplified mode too", () => {
    const renderChild = jest.fn(renderRow)
    const { getByTestId } = render(
      <ToolActivityGroup entries={ROWS} mode="simplified" renderChild={renderChild} />
    )
    fireEvent.click(getByTestId("tool-activity-group-toggle")) // open group
    expect(renderedTypes(renderChild)).toEqual(["tool-Read", "tool-Grep", "tool-Bash"])
    expect(getByTestId("row-tool-Bash")).toBeTruthy()
  })

  it("toggles a single row's expanded state in simplified mode", () => {
    const { getByTestId } = render(
      <ToolActivityGroup entries={ROWS} mode="simplified" renderChild={renderRow} />
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
      <ToolActivityGroup entries={ROWS} mode="simplified" renderChild={renderRow} />
    )
    fireEvent.click(getByTestId("tool-activity-group-toggle")) // open group
    fireEvent.click(getByTestId("tool-activity-group-expand-all"))
    expect(getByTestId("row-tool-Read").getAttribute("data-expanded")).toBe("true")
    expect(getByTestId("row-tool-Bash").getAttribute("data-expanded")).toBe("true")
  })

  it("expand-all forces cards open via forceOpen in standard mode", () => {
    const seen: Array<boolean | undefined> = []
    const renderChild = (part: { type: string }, key: string, opts: ToolActivityChildOptions) => {
      seen.push(opts.forceOpen)
      return renderRow(part, key, opts)
    }
    const { getByTestId } = render(
      <ToolActivityGroup entries={ROWS} mode="standard" renderChild={renderChild} />
    )
    seen.length = 0
    fireEvent.click(getByTestId("tool-activity-group-expand-all"))
    expect(seen).toContain(true)
  })

  // Expand-all must remount the children so an uncontrolled child re-reads the
  // new default; a stable key would leave the button inert.
  it("stamps a fresh key on every child when expand-all fires (standard)", () => {
    const keys: string[] = []
    const renderChild = (part: { type: string }, key: string, opts: ToolActivityChildOptions) => {
      keys.push(key)
      return renderRow(part, key, opts)
    }
    const { getByTestId } = render(
      <ToolActivityGroup entries={ROWS} mode="standard" renderChild={renderChild} />
    )
    const before = [...keys]
    keys.length = 0
    fireEvent.click(getByTestId("tool-activity-group-expand-all"))
    expect(keys.length).toBeGreaterThan(0)
    expect(keys.every((k) => !before.includes(k))).toBe(true)
  })

  it("detailed mode passes forceOpen=true to cards by default", () => {
    const seen: Array<boolean | undefined> = []
    const renderChild = (part: { type: string }, key: string, opts: ToolActivityChildOptions) => {
      seen.push(opts.forceOpen)
      return renderRow(part, key, opts)
    }
    render(<ToolActivityGroup entries={ROWS} mode="detailed" renderChild={renderChild} />)
    expect(seen.every((v) => v === true)).toBe(true)
  })

  it("renders the animated (AnimatePresence) body when motion is enabled", () => {
    mockMotion.reduce = false
    const { getByTestId } = render(
      <ToolActivityGroup entries={ROWS} mode="standard" renderChild={renderRow} />
    )
    expect(getByTestId("row-tool-Read")).toBeTruthy()
  })

  it("collapsing the group hides its body", () => {
    const { getByTestId, queryByTestId } = render(
      <ToolActivityGroup entries={ROWS} mode="standard" renderChild={renderRow} />
    )
    expect(getByTestId("row-tool-Read")).toBeTruthy()
    fireEvent.click(getByTestId("tool-activity-group-toggle"))
    expect(queryByTestId("row-tool-Read")).toBeNull()
  })
})
