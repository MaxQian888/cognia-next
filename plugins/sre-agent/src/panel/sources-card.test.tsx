/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({ useLocale: () => "en" }))

import type { SreIngestSource } from "../providers/types"
import type { SreRuntime } from "../runtime"
import { SourcesCard } from "./sources-card"

function runtimeWith(sources: SreIngestSource[] | Error): SreRuntime {
  return {
    sources: async () => {
      if (sources instanceof Error) throw sources
      return sources
    },
  } as unknown as SreRuntime
}

const STATIC: SreIngestSource = {
  id: "gateway-logs",
  label: "gateway",
  pipeline: "bundled fixture (JSONL)",
  status: "static",
  lagMs: null,
  recordCount: 5,
  bytes24h: null,
}

const LAGGING: SreIngestSource = {
  id: "vllm",
  label: "vllm-server",
  pipeline: "vector",
  status: "lagging",
  lagMs: 47000,
  recordCount: null,
  bytes24h: null,
}

describe("SourcesCard", () => {
  it("says a bundled source has no live pipeline instead of drawing a lag", async () => {
    render(<SourcesCard runtime={runtimeWith([STATIC])} />)
    await waitFor(() => expect(screen.getByTestId("sre-sources")).toBeInTheDocument())
    expect(screen.getByTestId("sre-source")).toHaveTextContent("no live pipeline")
    expect(screen.getByTestId("sre-source")).toHaveTextContent("5 records")
    expect(screen.getByText("bundled")).toBeInTheDocument()
  })

  it("reports a real lag in milliseconds", async () => {
    render(<SourcesCard runtime={runtimeWith([LAGGING])} />)
    await waitFor(() => expect(screen.getByTestId("sre-source")).toHaveTextContent("47,000 ms"))
    expect(screen.getByText("lagging")).toBeInTheDocument()
  })

  it("renders nothing at all until the backend answers", () => {
    render(
      <SourcesCard runtime={{ sources: () => new Promise(() => {}) } as unknown as SreRuntime} />
    )
    expect(screen.queryByTestId("sre-sources")).not.toBeInTheDocument()
  })

  it("degrades to an empty list when the backend refuses", async () => {
    render(<SourcesCard runtime={runtimeWith(new Error("nope"))} />)
    await waitFor(() => expect(screen.getByTestId("sre-sources")).toBeInTheDocument())
    expect(screen.queryByTestId("sre-source")).not.toBeInTheDocument()
  })
})
