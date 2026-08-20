/**
 * The composer's primary-button combination table.
 *
 * The regression this pins: streaming + typed text used to render Stop, which
 * left a typed follow-up with no way out (a send during a live turn is the
 * steer path, not a restart). Everything else here is the surrounding grid, so
 * fixing that case cannot quietly re-break emptiness, draft mode, or the
 * in-flight spinner.
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
      queues: false,
      variant: "default",
    })
  })

  it("enables Send once there is content", () => {
    const state = resolveSendButton(input({ hasContent: true }))
    expect(state.mode).toBe("send")
    expect(state.disabled).toBe(false)
    expect(state.queues).toBe(false)
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
      queues: false,
    })
  })
})

describe("resolveSendButton — streaming", () => {
  it("is Stop while the box is empty", () => {
    expect(resolveSendButton(input({ status: "streaming" }))).toEqual({
      mode: "stop",
      disabled: false,
      queues: false,
      variant: "destructive",
    })
  })

  it("becomes Send — queued as a follow-up — as soon as something is typed", () => {
    expect(resolveSendButton(input({ status: "streaming", hasContent: true }))).toEqual({
      mode: "send",
      disabled: false,
      queues: true,
      variant: "default",
    })
  })

  it("falls back to Stop when the typed follow-up could not be sent anyway", () => {
    expect(
      resolveSendButton(input({ status: "streaming", hasContent: true, composerDisabled: true }))
    ).toMatchObject({ mode: "stop", disabled: false })
    expect(
      resolveSendButton(input({ status: "streaming", hasContent: true, outboundBlocked: true }))
    ).toMatchObject({ mode: "stop", disabled: false })
  })

  it("keeps Stop clickable even when everything else is blocked", () => {
    const state = resolveSendButton(
      input({ status: "streaming", composerDisabled: true, outboundBlocked: true })
    )
    expect(state.mode).toBe("stop")
    expect(state.disabled).toBe(false)
  })
})

describe("resolveSendButton — in flight", () => {
  it("shows the non-interactive spinner while a dispatch is in flight", () => {
    expect(resolveSendButton(input({ hasContent: true, isSending: true }))).toEqual({
      mode: "busy",
      disabled: true,
      queues: false,
      variant: "default",
    })
  })

  it("shows the spinner while attachments are still being prepared", () => {
    expect(resolveSendButton(input({ isPreparingAttachments: true }))).toMatchObject({
      mode: "busy",
      disabled: true,
    })
  })

  it("lets the in-flight spinner win over Stop, so a queued follow-up is not mistaken for a stop", () => {
    expect(
      resolveSendButton(input({ status: "streaming", hasContent: true, isSending: true }))
    ).toMatchObject({ mode: "busy", disabled: true })
  })

  it("treats a dispatched-but-not-yet-streaming turn as busy", () => {
    expect(resolveSendButton(input({ status: "submitted", hasContent: true }))).toMatchObject({
      mode: "busy",
      disabled: true,
    })
  })
})

describe("resolveSendButton — connector draft review", () => {
  it("outranks every other state", () => {
    expect(
      resolveSendButton(input({ hasPendingDrafts: true, status: "streaming", hasContent: true }))
    ).toEqual({ mode: "draft", disabled: false, queues: false, variant: "secondary" })
  })

  it("follows the composer's disabled prop", () => {
    expect(
      resolveSendButton(input({ hasPendingDrafts: true, composerDisabled: true }))
    ).toMatchObject({ mode: "draft", disabled: true })
  })
})
