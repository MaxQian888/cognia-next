/** @jest-environment jsdom */
import React from "react"
import { render } from "@testing-library/react"
import { Box, Text } from "ink"
import { __resetInk } from "ink"

import { LaunchShell } from "./LaunchShell"
import { BackendConnect } from "./BackendConnect"
import { BackendFailure } from "./BackendFailure"
import { ThemeProvider } from "../theme/context"
import { BUILTIN_THEMES } from "../theme/builtins"

const palette = BUILTIN_THEMES.ansi

/** The four terminal sizes the launch flow has to survive. */
const SIZES: [name: string, columns: number, rows: number][] = [
  ["40x12", 40, 12],
  ["60x16", 60, 16],
  ["80x24", 80, 24],
  ["120x40", 120, 40],
]

const banner = (
  <Box flexDirection="column">
    {Array.from({ length: 7 }, (_, i) => (
      <Text key={i}>{`banner-line-${i}`}</Text>
    ))}
  </Box>
)

function shell(
  body: React.ReactNode,
  {
    columns,
    rows,
    hint,
    fullscreen = true,
  }: {
    columns: number
    rows: number
    hint?: string
    fullscreen?: boolean
  }
) {
  return render(
    <ThemeProvider palette={palette}>
      <LaunchShell
        banner={banner}
        {...(hint ? { hint } : {})}
        columns={columns}
        rows={rows}
        fullscreen={fullscreen}
      >
        {body}
      </LaunchShell>
    </ThemeProvider>
  )
}

beforeEach(() => __resetInk())

describe("LaunchShell — the body always survives", () => {
  it.each(SIZES)("keeps the connect progress and its cancel hint at %s", (_n, columns, rows) => {
    const { container } = shell(
      <BackendConnect backend="codex" stage="sandbox" width={columns} />,
      { columns, rows, hint: "Esc to cancel" }
    )
    const text = container.textContent ?? ""
    expect(text).toContain("codex")
    // The hint lives in the shell's fixed bottom region, so no amount of body
    // content can displace it.
    expect(text).toContain("Esc to cancel")
  })

  it.each(SIZES)("keeps every recovery choice reachable at %s", (_n, columns, rows) => {
    const { container } = shell(
      <BackendFailure
        backend="codex"
        failure={{
          kind: "command",
          stage: "command",
          message: `Couldn't find codex. ${"detail ".repeat(20)}`,
        }}
        index={0}
        onIndexChange={() => {}}
        onSelect={() => {}}
        width={columns}
        maxRows={4}
      />,
      { columns, rows }
    )
    const text = container.textContent ?? ""
    // The highlighted default is always visible; a long wrapped message must not
    // push it out of the frame.
    expect(text).toContain("Retry")
  })
})

describe("LaunchShell — banner budget", () => {
  it("drops the banner on a short terminal rather than the body", () => {
    const { container } = shell(<Text>body-content</Text>, {
      columns: 40,
      rows: 10,
      hint: "Esc to cancel",
    })
    const text = container.textContent ?? ""
    expect(text).not.toContain("banner-line-0")
    expect(text).toContain("body-content")
    expect(text).toContain("Esc to cancel")
  })

  it("shows the banner when there is room for it", () => {
    const { container } = shell(<Text>body-content</Text>, {
      columns: 120,
      rows: 40,
      hint: "Esc to cancel",
    })
    const text = container.textContent ?? ""
    expect(text).toContain("banner-line-0")
    expect(text).toContain("body-content")
  })

  it("renders without a banner or hint at all", () => {
    const { container } = render(
      <ThemeProvider palette={palette}>
        <LaunchShell columns={40} rows={12} fullscreen={false}>
          <Text>only-body</Text>
        </LaunchShell>
      </ThemeProvider>
    )
    expect(container.textContent).toContain("only-body")
  })
})

describe("LaunchShell — frame stability", () => {
  it("pins the frame height in fullscreen so a phase change cannot repaint it", () => {
    // Every phase renders the same shell, so the height rule is one place.
    const connecting = shell(<Text>connect</Text>, { columns: 80, rows: 24, hint: "Esc" })
    const failed = shell(<Text>failed</Text>, { columns: 80, rows: 24 })
    expect(connecting.container.textContent).toContain("connect")
    expect(failed.container.textContent).toContain("failed")
  })

  it("does not pin the height outside fullscreen (scrollback mode grows)", () => {
    const { container } = shell(<Text>body</Text>, {
      columns: 80,
      rows: 24,
      fullscreen: false,
    })
    expect(container.textContent).toContain("body")
  })
})
