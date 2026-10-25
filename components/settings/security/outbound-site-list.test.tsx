/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import { siteTarget } from "@/lib/policy/action-review/outbound-targets"
import type { OutboundRecipientGrant } from "@cognia/agent-config-types/action-review"

const FORMS = siteTarget("https://forms.example.com")!

let mockedSettings: Record<string, unknown> | null = {}
const saveMock = jest.fn(async (_patch: unknown) => undefined)
jest.mock("@/stores/settings", () => {
  const useSettingsStore = (select: (state: unknown) => unknown) =>
    select({ settings: mockedSettings, save: saveMock })
  useSettingsStore.getState = () => ({ settings: mockedSettings, save: saveMock })
  return { useSettingsStore }
})

const success = jest.fn()
const error = jest.fn()
jest.mock("sonner", () => ({
  toast: { success: (m: string) => success(m), error: (m: string) => error(m) },
}))

import { OutboundSiteList } from "./outbound-site-list"

function grant(target: { kind: string; channel: string; recipient: string }) {
  return {
    recipient: target,
    addedAt: 1,
    addedBy: "local-user",
  } as OutboundRecipientGrant
}

beforeEach(() => {
  mockedSettings = {}
  saveMock.mockReset()
  saveMock.mockImplementation(async () => undefined)
  success.mockClear()
  error.mockClear()
})

describe("OutboundSiteList", () => {
  it("says what the list does, and starts empty", () => {
    render(<OutboundSiteList />)
    expect(screen.getByTestId("outbound-site-list")).toHaveTextContent(
      "will go ahead without asking"
    )
    expect(screen.queryByText(/Not yet in effect/)).not.toBeInTheDocument()
    expect(screen.getByTestId("outbound-site-list-editor-empty")).toBeInTheDocument()
  })

  it("lists the valid site entries a person saved, and nothing else", () => {
    mockedSettings = {
      agentPermissions: {
        outboundSites: [
          grant(FORMS),
          grant({ kind: "mail", channel: "mail", recipient: "mail:a@b.co" }),
          "https://evil.example",
        ],
      },
    }
    render(<OutboundSiteList />)
    const items = screen.getAllByRole("listitem")
    expect(items).toHaveLength(1)
    expect(items[0]).toHaveTextContent("https://forms.example.com")
  })

  it("adds a typed address as its origin, keeping the other permissions", async () => {
    mockedSettings = {
      agentPermissions: { outboundAuthorization: "enforce", toolRules: { Bash: "ask" } },
    }
    render(<OutboundSiteList />)
    fireEvent.change(screen.getByLabelText("https://example.com"), {
      target: { value: "https://Forms.Example.com/contact?x=1" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Add" }))
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1))
    expect(saveMock.mock.calls[0][0]).toEqual({
      agentPermissions: {
        outboundAuthorization: "enforce",
        toolRules: { Bash: "ask" },
        outboundSites: [{ recipient: FORMS, addedAt: expect.any(Number), addedBy: "local-user" }],
      },
    })
    expect(success).toHaveBeenCalledWith("Recipient list saved")
  })

  it("removes a site", async () => {
    mockedSettings = { agentPermissions: { outboundSites: [grant(FORMS)] } }
    render(<OutboundSiteList />)
    fireEvent.click(screen.getByRole("button", { name: "Remove https://forms.example.com" }))
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1))
    expect(saveMock.mock.calls[0][0]).toEqual({ agentPermissions: { outboundSites: [] } })
  })

  it("says why a save failed", async () => {
    saveMock.mockImplementation(async () => {
      throw new Error("disk full")
    })
    render(<OutboundSiteList />)
    fireEvent.change(screen.getByLabelText("https://example.com"), {
      target: { value: "https://forms.example.com" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Add" }))
    await waitFor(() =>
      expect(error).toHaveBeenCalledWith("Could not save the recipient list: disk full")
    )
    expect(success).not.toHaveBeenCalled()
  })

  it("edits nothing while disabled (a paired Host) or before settings load", () => {
    const { unmount } = render(<OutboundSiteList disabled />)
    expect(screen.getByLabelText("https://example.com")).toBeDisabled()
    unmount()
    mockedSettings = null
    render(<OutboundSiteList />)
    expect(screen.getByLabelText("https://example.com")).toBeDisabled()
  })
})
