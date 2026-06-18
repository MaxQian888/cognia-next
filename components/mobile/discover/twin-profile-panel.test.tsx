/**
 * @jest-environment jsdom
 */

import { render, screen, waitFor } from "@testing-library/react"

import { TwinProfilePanel } from "./twin-profile-panel"
import { transport } from "@/lib/tauri"
import type { TwinProfile } from "@/types/twin"

// Param-aware mock so the test can prove the pluralized count actually flows
// through (the bug being fixed was that counts always rendered 0).
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))

jest.mock("@/lib/tauri", () => ({
  transport: { call: jest.fn() },
}))

const callMock = transport.call as jest.Mock

function rawProfile(overrides: Partial<TwinProfile> = {}): TwinProfile {
  return {
    id: "default",
    twinId: "default",
    styleSamples: [
      { id: "s1", summary: "a", sourceChunkId: "c1" },
      { id: "s2", summary: "b", sourceChunkId: "c2" },
    ] as TwinProfile["styleSamples"],
    playbooks: [],
    entities: [{ name: "Ada", role: "person" }] as TwinProfile["entities"],
    decisions: [],
    voiceSummary: "Direct and concise.",
    updatedAt: 4242,
    ...overrides,
  }
}

beforeEach(() => {
  callMock.mockReset()
})

describe("TwinProfilePanel", () => {
  it("shows the loading state until the RPC resolves", () => {
    callMock.mockReturnValue(new Promise(() => {}))
    render(<TwinProfilePanel twinId="default" />)
    expect(screen.getByText("loading")).toBeInTheDocument()
  })

  it("renders the failure message with the error text", async () => {
    callMock.mockRejectedValue(new Error("boom"))
    render(<TwinProfilePanel twinId="default" />)
    expect(await screen.findByText('loadFailed:{"message":"boom"}')).toBeInTheDocument()
  })

  it("shows the empty state when there is no profile row", async () => {
    callMock.mockResolvedValue({ profile: null })
    render(<TwinProfilePanel twinId="default" />)
    expect(await screen.findByText("empty")).toBeInTheDocument()
  })

  it("projects the raw row into real sample/entity counts and the style summary", async () => {
    callMock.mockResolvedValue({ profile: rawProfile() })
    render(<TwinProfilePanel twinId="default" />)
    expect(await screen.findByTestId("twin-profile-panel")).toBeInTheDocument()
    expect(screen.getByText('samples:{"count":2}')).toBeInTheDocument()
    expect(screen.getByText('entities:{"count":1}')).toBeInTheDocument()
    expect(screen.getByText("Direct and concise.")).toBeInTheDocument()
  })

  it("hides the style block when the voice summary is blank", async () => {
    callMock.mockResolvedValue({ profile: rawProfile({ voiceSummary: "  " }) })
    render(<TwinProfilePanel twinId="default" />)
    expect(await screen.findByTestId("twin-profile-panel")).toBeInTheDocument()
    expect(screen.queryByText("style")).not.toBeInTheDocument()
  })

  it("defaults twinId to \"default\" when omitted", () => {
    callMock.mockReturnValue(new Promise(() => {}))
    render(<TwinProfilePanel />)
    expect(callMock).toHaveBeenCalledWith("twin_profile_get", { twinId: "default" })
  })

  it("drops back to loading when twinId changes", async () => {
    callMock.mockResolvedValueOnce({ profile: rawProfile() })
    const { rerender } = render(<TwinProfilePanel twinId="default" />)
    await screen.findByTestId("twin-profile-panel")

    callMock.mockReturnValue(new Promise(() => {}))
    rerender(<TwinProfilePanel twinId="other" />)
    await waitFor(() => expect(screen.getByText("loading")).toBeInTheDocument())
  })
})
