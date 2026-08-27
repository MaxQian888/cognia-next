/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { ConnectorPolicySheet, type ConnectorPolicy } from "./connector-policy-sheet"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    const map: Record<string, string> = {
      title: `Settings for ${vars?.name ?? ""}`,
      description: "How this bot behaves in every chat it is in.",
      modeAuto: "Auto",
      modeDraft: "Draft",
      modeManual: "Manual",
      muted: "Mute this bot",
      mutedHelp: "help",
      quietHours: "Quiet hours",
      quietHoursHelp: "help",
      capabilitiesHelp: "help",
      triggerSection: "When this bot replies",
      triggerHelp: "help",
      from: "From",
      to: "To",
      save: "Save",
      saving: "Saving…",
      saved: "Settings saved.",
      saveFailed: `Save failed: ${vars?.message ?? ""}`,
      queueLabel: `Queued for ${vars?.name ?? ""}`,
    }
    return map[key] ?? key
  },
}))

const toastSuccess = jest.fn()
const toastError = jest.fn()
jest.mock("sonner", () => ({
  toast: { success: (...a: unknown[]) => toastSuccess(...a), error: (...a: unknown[]) => toastError(...a) },
}))

const updateMock = jest.fn(async (..._a: unknown[]) => 1)
const modifyMock = jest.fn(async (..._a: unknown[]) => 1)
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    adapterInstances: {
      update: (...a: unknown[]) => updateMock(...a),
      where: () => ({ equals: () => ({ modify: (...a: unknown[]) => modifyMock(...a) }) }),
    },
  }),
}))

const enqueueMock = jest.fn(async (..._a: unknown[]) => ({}))
jest.mock("@/lib/db/mobile-outbound-queue", () => ({
  enqueue: (...a: unknown[]) => enqueueMock(...a),
}))

function makePolicy(overrides: Partial<ConnectorPolicy> = {}): ConnectorPolicy {
  return {
    id: "ad-1",
    displayName: "Team Telegram",
    defaultMode: "auto",
    muted: false,
    ...overrides,
  }
}

/** The wire payload the sheet handed to the outbound queue. */
const sentPayload = () =>
  (enqueueMock.mock.calls[0][0] as { payload: Record<string, unknown> }).payload

/** The optimistic patch the sheet applied to its own mirror. */
const mirrorPatch = () => updateMock.mock.calls[0][1] as Record<string, unknown>

beforeEach(() => {
  updateMock.mockClear()
  modifyMock.mockClear()
  enqueueMock.mockClear()
  toastSuccess.mockClear()
  toastError.mockClear()
})

describe("<ConnectorPolicySheet />", () => {
  it("renders nothing without a policy", () => {
    const { container } = render(
      <ConnectorPolicySheet open policy={null} onOpenChange={jest.fn()} />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it("saves without quiet hours: one Dexie update, RPC enqueued with an explicit null", async () => {
    const onOpenChange = jest.fn()
    const user = userEvent.setup()
    render(<ConnectorPolicySheet open policy={makePolicy()} onOpenChange={onOpenChange} />)

    await user.click(screen.getByTestId("policy-save"))

    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith(
        "ad-1",
        expect.objectContaining({ defaultMode: "auto", muted: false })
      )
    )
    // The unset now rides on the same `update` — `undefined` in a Dexie patch
    // removes the key, so there is no second `modify` pass to keep in sync.
    expect(modifyMock).not.toHaveBeenCalled()
    expect(Object.keys(mirrorPatch())).toContain("quietHours")
    expect(mirrorPatch().quietHours).toBeUndefined()
    expect(sentPayload()).toMatchObject({ id: "ad-1", quietHours: null })
    expect(toastSuccess).toHaveBeenCalledWith("Settings saved.")
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it("saves a full quiet-hours window when both bounds are set", async () => {
    const user = userEvent.setup()
    render(<ConnectorPolicySheet open policy={makePolicy({ muted: true })} onOpenChange={jest.fn()} />)

    fireEvent.change(screen.getByTestId("policy-quiet-from"), { target: { value: "22:00" } })
    fireEvent.change(screen.getByTestId("policy-quiet-to"), { target: { value: "07:00" } })
    await user.click(screen.getByTestId("policy-save"))

    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith(
        "ad-1",
        expect.objectContaining({
          muted: true,
          quietHours: expect.objectContaining({ from: "22:00", to: "07:00" }),
        })
      )
    )
    expect(sentPayload().quietHours).toMatchObject({ from: "22:00", to: "07:00" })
  })

  it("persists the shared behavior fields and converts activation TTL hours", async () => {
    const user = userEvent.setup()
    render(
      <ConnectorPolicySheet
        open
        policy={makePolicy({
          inboundActivationPolicy: "always",
          activeRunDispatchMode: "steer",
          activationTtlMs: 7_200_000,
        })}
        onOpenChange={jest.fn()}
      />
    )

    expect(screen.getByTestId("conversation-behavior-editor")).toBeInTheDocument()
    expect(screen.getByTestId("behavior-ttl")).toHaveValue(2)
    fireEvent.change(screen.getByTestId("behavior-ttl"), { target: { value: "3" } })
    await user.click(screen.getByTestId("policy-save"))

    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith(
        "ad-1",
        expect.objectContaining({
          inboundActivationPolicy: "always",
          activeRunDispatchMode: "steer",
          activationTtlMs: 10_800_000,
        })
      )
    )
    expect(sentPayload().activationTtlMs).toBe(10_800_000)
  })

  it("normalizes an invalid activation TTL to unpinned", async () => {
    const user = userEvent.setup()
    render(<ConnectorPolicySheet open policy={makePolicy()} onOpenChange={jest.fn()} />)
    fireEvent.change(screen.getByTestId("behavior-ttl"), { target: { value: "0" } })
    await user.click(screen.getByTestId("policy-save"))
    await waitFor(() => expect(enqueueMock).toHaveBeenCalled())
    expect(sentPayload().activationTtlMs).toBeNull()
    expect(mirrorPatch().activationTtlMs).toBeUndefined()
  })

  describe("composition axes", () => {
    // Every control below was already rendered by the behaviour editor this
    // sheet mounts. None of them was seeded, captured, or relayed: the phone
    // moved a slider, said "saved", and the bot kept routing on what it had.
    it("seeds the axes the bot actually holds and relays them back", async () => {
      const user = userEvent.setup()
      render(
        <ConnectorPolicySheet
          open
          policy={makePolicy({
            defaultAutonomy: "confirm",
            defaultEngagement: "background",
            defaultAuthority: "acceptEdits",
            a2uiEnabled: false,
          })}
          onOpenChange={jest.fn()}
        />
      )
      await user.click(screen.getByTestId("policy-save"))

      await waitFor(() => expect(enqueueMock).toHaveBeenCalled())
      expect(sentPayload()).toMatchObject({
        defaultAutonomy: "confirm",
        defaultEngagement: "background",
        defaultAuthority: "acceptEdits",
        a2uiEnabled: false,
      })
    })

    it("carries an unpinned axis as null, which is the only way JSON can say 'clear'", async () => {
      const user = userEvent.setup()
      render(<ConnectorPolicySheet open policy={makePolicy()} onOpenChange={jest.fn()} />)
      await user.click(screen.getByTestId("policy-save"))

      await waitFor(() => expect(enqueueMock).toHaveBeenCalled())
      expect(sentPayload()).toMatchObject({
        defaultAutonomy: null,
        defaultEngagement: null,
        defaultAuthority: null,
        a2uiEnabled: null,
      })
      // …and the mirror drops the same keys, rather than keeping a value the
      // host is about to forget.
      expect(Object.keys(mirrorPatch())).toEqual(
        expect.arrayContaining(["defaultAutonomy", "defaultEngagement", "defaultAuthority"])
      )
      expect(mirrorPatch().defaultAutonomy).toBeUndefined()
    })

    it("derives the mirror from the payload, so the two cannot disagree", async () => {
      const user = userEvent.setup()
      render(
        <ConnectorPolicySheet
          open
          policy={makePolicy({ defaultAutonomy: "act" })}
          onOpenChange={jest.fn()}
        />
      )
      await user.click(screen.getByTestId("policy-save"))

      await waitFor(() => expect(enqueueMock).toHaveBeenCalled())
      const payload = sentPayload()
      const patch = mirrorPatch()
      for (const [key, value] of Object.entries(payload)) {
        if (key === "id") continue
        expect(patch[key]).toEqual(value === null ? undefined : value)
      }
    })
  })

  describe("host capability ceiling", () => {
    it("sends no clamp at all when every capability is allowed", async () => {
      const user = userEvent.setup()
      render(<ConnectorPolicySheet open policy={makePolicy()} onOpenChange={jest.fn()} />)
      await user.click(screen.getByTestId("policy-save"))

      await waitFor(() => expect(enqueueMock).toHaveBeenCalled())
      // `[everything]` and "no ceiling" mean the same thing; storing the list
      // would freeze the bot out of any capability added later.
      expect(sentPayload().hostCapabilityCeiling).toBeNull()
    })

    it("clamps the capabilities the operator turned off", async () => {
      const user = userEvent.setup()
      render(<ConnectorPolicySheet open policy={makePolicy()} onOpenChange={jest.fn()} />)

      await user.click(screen.getByTestId("policy-capability-ocr"))
      await user.click(screen.getByTestId("policy-capability-computer_use"))
      await user.click(screen.getByTestId("policy-save"))

      await waitFor(() => expect(enqueueMock).toHaveBeenCalled())
      expect(sentPayload().hostCapabilityCeiling).toEqual(["goal_driving", "schedule_tools"])
    })

    it("seeds from a stored clamp instead of showing everything on", () => {
      render(
        <ConnectorPolicySheet
          open
          policy={makePolicy({ hostCapabilityCeiling: ["ocr"] })}
          onOpenChange={jest.fn()}
        />
      )
      expect(screen.getByTestId("policy-capability-ocr")).toBeChecked()
      expect(screen.getByTestId("policy-capability-computer_use")).not.toBeChecked()
    })
  })

  describe("trigger policy", () => {
    const trigger = {
      rules: [{ kind: "private-default" as const }],
      blockers: [],
      storeUnmatchedInDraftMode: false,
    }

    it("stays out of the payload while the operator never opens it", async () => {
      const user = userEvent.setup()
      render(
        <ConnectorPolicySheet open policy={makePolicy({ trigger })} onOpenChange={jest.fn()} />
      )
      await user.click(screen.getByTestId("policy-save"))

      await waitFor(() => expect(enqueueMock).toHaveBeenCalled())
      // Absent means "leave it". Sending one on every save would let a mirror
      // that had not synced yet overwrite the bot's real gating with an empty
      // policy — a bot that answers nobody.
      expect(sentPayload()).not.toHaveProperty("trigger")
    })

    it("relays the whole policy once a rule is changed", async () => {
      const user = userEvent.setup()
      render(
        <ConnectorPolicySheet open policy={makePolicy({ trigger })} onOpenChange={jest.fn()} />
      )

      await user.click(screen.getByTestId("policy-trigger-toggle"))
      await user.click(screen.getByTestId("mobile-trigger-rule-self-mention-switch"))
      await user.click(screen.getByTestId("policy-save"))

      await waitFor(() => expect(enqueueMock).toHaveBeenCalled())
      expect(sentPayload().trigger).toEqual({
        rules: [{ kind: "private-default" }, { kind: "self-mention" }],
        blockers: [],
        storeUnmatchedInDraftMode: false,
      })
    })
  })

  it("re-seeds the form when the sheet opens for a different adapter", async () => {
    const { rerender } = render(
      <ConnectorPolicySheet open policy={makePolicy()} onOpenChange={jest.fn()} />
    )
    rerender(
      <ConnectorPolicySheet
        open
        policy={makePolicy({
          id: "ad-2",
          displayName: "Support Discord",
          quietHours: { from: "21:00", to: "08:00", tz: "UTC" },
          hostCapabilityCeiling: ["ocr"],
        })}
        onOpenChange={jest.fn()}
      />
    )
    expect(screen.getByText("Settings for Support Discord")).toBeInTheDocument()
    expect((screen.getByTestId("policy-quiet-from") as HTMLInputElement).value).toBe("21:00")
    expect((screen.getByTestId("policy-quiet-to") as HTMLInputElement).value).toBe("08:00")
    expect(screen.getByTestId("policy-capability-goal_driving")).not.toBeChecked()
  })

  it("surfaces a save failure as an error toast and keeps the sheet open", async () => {
    updateMock.mockRejectedValueOnce(new Error("boom"))
    const onOpenChange = jest.fn()
    const user = userEvent.setup()
    render(<ConnectorPolicySheet open policy={makePolicy()} onOpenChange={onOpenChange} />)

    await user.click(screen.getByTestId("policy-save"))

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Save failed: boom"))
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })
})
