/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

import { TwinProfileCard } from "./twin-profile-card"
import { useLiveQuery } from "dexie-react-hooks"
import type { TwinProfile } from "@/types/twin"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: jest.fn(),
}))

jest.mock("@/lib/db/twin-profile", () => ({
  getTwinProfile: jest.fn(),
}))

const liveQueryMock = useLiveQuery as jest.Mock

function rawProfile(overrides: Partial<TwinProfile> = {}): TwinProfile {
  return {
    id: "default",
    twinId: "default",
    styleSamples: [{ id: "s1", summary: "a", sourceChunkId: "c1" }] as TwinProfile["styleSamples"],
    playbooks: [],
    entities: [
      { name: "Ada", role: "person" },
      { name: "Cognia", role: "project" },
    ] as TwinProfile["entities"],
    decisions: [],
    voiceSummary: "Warm, precise.",
    updatedAt: 99,
    ...overrides,
  }
}

beforeEach(() => {
  liveQueryMock.mockReset()
})

describe("TwinProfileCard", () => {
  it("shows loading while the live query is still settling (sentinel default)", () => {
    liveQueryMock.mockReturnValue("__loading__")
    render(<TwinProfileCard twinId="default" />)
    expect(screen.getByText("loading")).toBeInTheDocument()
  })

  it("shows the empty state when the row is missing", () => {
    liveQueryMock.mockReturnValue(undefined)
    render(<TwinProfileCard twinId="default" />)
    expect(screen.getByText("empty")).toBeInTheDocument()
  })

  it("renders projected counts and the style summary from the Dexie row", () => {
    liveQueryMock.mockReturnValue(rawProfile())
    render(<TwinProfileCard twinId="default" />)
    expect(screen.getByTestId("twin-profile-card")).toBeInTheDocument()
    expect(screen.getByText('samples:{"count":1}')).toBeInTheDocument()
    expect(screen.getByText('entities:{"count":2}')).toBeInTheDocument()
    expect(screen.getByText("Warm, precise.")).toBeInTheDocument()
  })

  it("omits the style block and updatedAt prose when there is none", () => {
    liveQueryMock.mockReturnValue(rawProfile({ voiceSummary: "", updatedAt: 0 }))
    render(<TwinProfileCard twinId="default" />)
    expect(screen.queryByText("style")).not.toBeInTheDocument()
    expect(screen.getByText("noUpdates")).toBeInTheDocument()
  })
})
