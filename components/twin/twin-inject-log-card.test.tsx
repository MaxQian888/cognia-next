/**
 * @jest-environment jsdom
 *
 * Coverage for the inject-log diagnostic card: empty state, ring-buffer
 * read on mount, subscription updates, and per-twin filtering.
 */

import React from "react"
import { act, render, screen } from "@testing-library/react"

jest.mock("motion/react", () => ({
  motion: {
    li: ({ children, className, ...props }: React.LiHTMLAttributes<HTMLLIElement>) => (
      <li className={className} {...props}>
        {children}
      </li>
    ),
  },
  useReducedMotion: () => true,
}))

import { TwinInjectLogCard } from "./twin-inject-log-card"
import {
  recordTwinInject,
  __resetTwinInjectLog,
  type TwinInjectLogEntry,
} from "@/lib/twin/runtime/inject-log"

const entry = (overrides: Partial<TwinInjectLogEntry>): TwinInjectLogEntry => ({
  ts: Date.now(),
  twinId: "twin_alice",
  source: "rag",
  applied: true,
  degraded: false,
  degradedReason: null,
  chunkCount: 0,
  styleSampleCount: 0,
  tokensApprox: 0,
  ...overrides,
})

beforeEach(() => {
  __resetTwinInjectLog()
})

describe("TwinInjectLogCard", () => {
  it("renders the empty hint when the buffer has no entries for this twin", () => {
    render(<TwinInjectLogCard twinId="twin_alice" />)
    expect(screen.getByTestId("twin-inject-log-card")).toBeInTheDocument()
    expect(screen.getByText(/No injections yet/i)).toBeInTheDocument()
  })

  it("renders a row for each applied injection", async () => {
    recordTwinInject(entry({ chunkCount: 3, styleSampleCount: 1, tokensApprox: 200 }))
    render(<TwinInjectLogCard twinId="twin_alice" />)
    expect(await screen.findByTestId("twin-inject-log-row-0")).toBeInTheDocument()
    expect(screen.getByText(/applied/i)).toBeInTheDocument()
    expect(screen.getByText(/3 chunks/i)).toBeInTheDocument()
  })

  it("ignores entries for other twins", () => {
    recordTwinInject(entry({ twinId: "twin_bob", chunkCount: 5 }))
    render(<TwinInjectLogCard twinId="twin_alice" />)
    expect(screen.queryByTestId("twin-inject-log-row-0")).toBeNull()
    expect(screen.getByText(/No injections yet/i)).toBeInTheDocument()
  })

  it("refreshes when new entries are appended after mount", async () => {
    render(<TwinInjectLogCard twinId="twin_alice" />)
    expect(screen.queryByTestId("twin-inject-log-row-0")).toBeNull()
    act(() => {
      recordTwinInject(
        entry({
          applied: false,
          degraded: true,
          degradedReason: "embedding api timeout",
          source: "style",
        })
      )
    })
    expect(await screen.findByTestId("twin-inject-log-row-0")).toBeInTheDocument()
    expect(screen.getByText(/embedding api timeout/i)).toBeInTheDocument()
  })
})
