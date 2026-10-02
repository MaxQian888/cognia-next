/**
 * The composer's primary-button combination table.
 *
 * The regressions this pins: while a turn runs the primary button is Stop —
 * whatever is typed, and however long the runtime keeps its dispatch pending.
 * It used to be taken over by Send once text was typed, and to sit on a
 * spinner for a whole external-agent run. A typed follow-up still has a way
 * out: the secondary `followUp` control. Everything else here is the
 * surrounding grid, so that change cannot quietly re-break emptiness, draft
 * mode, or the in-flight spinner.
 */

import { resolveSendButton, type SendButtonInput } from "./send-button-mode"

function input(overrides: Partial<SendButtonInput> = {}): SendButtonInput {
  return {
    status: "ready",
    isSending: false,
    isPreparingAttachments: false,
    hasContent: false,
    hasPendingDrafts: false,
    composerDisabled: false,
    outboundBlocked: false,
    ...overrides,
  }
}

describe("resolveSendButton — idle", () => {
  it("is a disabled Send with an empty box", () => {
    expect(resolveSendButton(input())).toEqual({
      mode: "send",
      disabled: true,
      variant: "default",
      followUp: null,
    })
  })

  it("enables Send once there is content", () => {
    const state = resolveSendButton(input({ hasContent: true }))
    expect(state.mode).toBe("send")
    expect(state.disabled).toBe(false)
    expect(state.followUp).toBeNull()
  })

  it("stays disabled when the composer is disabled", () => {
    expect(resolveSendButton(input({ hasContent: true, composerDisabled: true }))).toMatchObject({
      mode: "send",
      disabled: true,
    })
  })

  it("stays disabled when this shell cannot send outbound", () => {
    expect(resolveSendButton(input({ hasContent: true, outboundBlocked: true }))).toMatchObject({
      mode: "send",
      disabled: true,
    })
  })

  it("treats an errored turn like idle — Send, enabled by content", () => {
    expect(resolveSendButton(input({ status: "error", hasContent: true }))).toMatchObject({
      mode: "send",
      disabled: false,
      followUp: null,
    })
  })
})

describe("resolveSendButton — streaming", () => {
  it("is Stop while the box is empty, with no follow-up control", () => {
    expect(resolveSendButton(input({ status: "streaming" }))).toEqual({
      mode: "stop",
      disabled: false,
      variant: "default",
      followUp: null,
    })
  })

  it("stays Stop once something is typed, and offers the follow-up beside it", () => {
    expect(resolveSendButton(input({ status: "streaming", hasContent: true }))).toEqual({
      mode: "stop",
      disabled: false,
      variant: "default",
      followUp: { disabled: false, busy: false },
    })
  })

  it("offers no follow-up when the typed text could not be sent anyway", () => {
    expect(
      resolveSendButton(input({ status: "streaming", hasContent: true, composerDisabled: true }))
    ).toMatchObject({ mode: "stop", disabled: false, followUp: null })
    expect(
      resolveSendButton(input({ status: "streaming", hasContent: true, outboundBlocked: true }))
    ).toMatchObject({ mode: "stop", disabled: false, followUp: null })
  })

  it("keeps Stop clickable even when everything else is blocked", () => {
    const state = resolveSendButton(
      input({ status: "streaming", composerDisabled: true, outboundBlocked: true })
    )
    expect(state.mode).toBe("stop")
    expect(state.disabled).toBe(false)
  })

  it("keeps Stop while a follow-up is being dispatched, showing the follow-up as busy", () => {
    expect(resolveSendButton(input({ status: "streaming", isSending: true }))).toEqual({
      mode: "stop",
      disabled: false,
      variant: "default",
      followUp: { disabled: true, busy: true },
    })
  })

  it("shows the follow-up as busy while its attachment is still being prepared", () => {
    expect(
      resolveSendButton(
        input({ status: "streaming", hasContent: true, isPreparingAttachments: true })
      )
    ).toMatchObject({ mode: "stop", disabled: false, followUp: { disabled: true, busy: true } })
  })
})

describe("resolveSendButton — in flight", () => {
  it("shows the non-interactive spinner while a dispatch is in flight", () => {
    expect(resolveSendButton(input({ hasContent: true, isSending: true }))).toEqual({
      mode: "busy",
      disabled: true,
      variant: "default",
      followUp: null,
    })
  })

  it("shows the spinner while attachments are still being prepared", () => {
    expect(resolveSendButton(input({ isPreparingAttachments: true }))).toMatchObject({
      mode: "busy",
      disabled: true,
    })
  })

  it("treats a dispatched-but-not-yet-streaming turn as busy", () => {
    expect(resolveSendButton(input({ status: "submitted", hasContent: true }))).toMatchObject({
      mode: "busy",
      disabled: true,
    })
  })
})

describe("resolveSendButton — connector draft review", () => {
  it("offers the waiting drafts when the box is empty", () => {
    expect(resolveSendButton(input({ hasPendingDrafts: true }))).toEqual({
      mode: "draft",
      disabled: false,
      variant: "secondary",
      followUp: null,
    })
  })

  // A pending draft must never stand between someone and their own reply.
  it("gives the button back to Send the moment there is something typed", () => {
    expect(resolveSendButton(input({ hasPendingDrafts: true, hasContent: true }))).toEqual({
      mode: "send",
      disabled: false,
      variant: "default",
      followUp: null,
    })
  })

  // Opening the review dialog is local — the stream cap and a shell that
  // cannot write outbound have no bearing on it.
  it("stays reviewable while the composer or the outbound path is blocked", () => {
    expect(
      resolveSendButton(
        input({ hasPendingDrafts: true, composerDisabled: true, outboundBlocked: true })
      )
    ).toMatchObject({ mode: "draft", disabled: false })
  })

  it("yields to a dispatch in flight", () => {
    expect(resolveSendButton(input({ hasPendingDrafts: true, isSending: true }))).toMatchObject({
      mode: "busy",
      disabled: true,
    })
  })

  it("yields to Stop while a turn is running", () => {
    expect(resolveSendButton(input({ hasPendingDrafts: true, status: "streaming" }))).toMatchObject(
      { mode: "stop" }
    )
  })
})
