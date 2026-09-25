import type { ConsentRequestEvent } from "@/lib/automation/client"
import type { CopilotResult } from "../run-copilot"
import { createScreenCopilotController, type ScreenCopilotControllerDeps } from "./controller"
import type { ChatCopilotView } from "./overlay-client"
import { ScreenCopilotError, type ScreenAnchor, type ScreenRead } from "./run-screen-copilot"

const anchor: ScreenAnchor = { x: 100, y: 50, width: 500, height: 400, scale: 2 }

const read = {
  app: { name: "WeChat", windowTitle: "WeChat", id: "wechat", layout: "two_sided" },
  anchor,
  transcript: { turns: [], latestFrom: "other", latestOtherSender: null, isGroup: false },
  unsidedReason: null,
  bubbleCount: 3,
  contact: { kind: "none" },
  knowledge: {
    relationship: "",
    background: "",
    contactId: null,
    contactName: null,
    hasNote: false,
    memoryLines: 0,
    memorySkipped: "disabled",
  },
  ocrProviderId: "apple-vision",
} as ScreenRead

const result = { variant: "full" } as CopilotResult

const consentEvent: ConsentRequestEvent = {
  id: "c1",
  command: "capture_frontmost_window",
  surface: "chatCopilot",
  pluginId: null,
  processName: "WeChat",
  windowTitle: "Ann",
  timeoutMs: 90_000,
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function harness(overrides: Partial<ScreenCopilotControllerDeps> = {}) {
  let consentHandler: ((event: ConsentRequestEvent) => void) | null = null
  const views: ChatCopilotView[] = []
  const release = jest.fn()
  const deps: ScreenCopilotControllerDeps = {
    settings: () => null,
    read: jest.fn(async (_settings, options) => {
      options.onPhase?.("capturing")
      options.onPhase?.("reading", anchor)
      return read
    }),
    draft: jest.fn(async () => result),
    overlay: {
      open: jest.fn(async () => true),
      place: jest.fn(async () => undefined),
      close: jest.fn(async () => undefined),
      send: jest.fn(async (view: ChatCopilotView) => {
        views.push(view)
        return true
      }),
    },
    consent: {
      subscribe: (handler) => {
        consentHandler = handler
        return () => {
          consentHandler = null
        }
      },
      respond: jest.fn(async () => undefined),
      promptOf: (event) => ({
        command: event.command,
        surface: event.surface,
        pluginId: null,
        processName: event.processName,
        windowTitle: event.windowTitle,
        commandDetail: null,
        sessionKey: null,
      }),
      claim: jest.fn(() => release),
      settle: jest.fn(),
    },
    openScreenRecordingSettings: jest.fn(async () => undefined),
    onOverlayUnavailable: jest.fn(),
    now: () => 1_000,
    ...overrides,
  }
  const controller = createScreenCopilotController(deps)
  return {
    controller,
    deps,
    views,
    release,
    emitConsent: (e: ConsentRequestEvent) => consentHandler?.(e),
  }
}

describe("screen copilot controller", () => {
  it("captures, opens the overlay beside the chat window and shows the candidates", async () => {
    const { controller, deps, views } = harness()
    await controller.start()
    await flush()
    expect(deps.consent.claim).toHaveBeenCalledTimes(1)
    expect(deps.overlay.open).toHaveBeenCalledWith(anchor)
    expect(deps.overlay.open).toHaveBeenCalledTimes(1)
    // The read came back before the overlay opened, so it never steps back
    // to "reading" once drafting has started.
    expect(views.map((view) => view.phase)).toEqual(["thinking", "done"])
    expect(views.at(-1)).toMatchObject({
      phase: "done",
      result,
      read: { appName: "WeChat", bubbleCount: 3 },
      instructions: "",
    })
  })

  it("opens the overlay only once the capture asks, and answers the prompt for it", async () => {
    const capture = deferred<ScreenRead>()
    let onPhase: ((phase: "reading", anchor: ScreenAnchor) => void) | undefined
    const { controller, deps, views, emitConsent } = harness({
      read: jest.fn((_settings, options) => {
        onPhase = options.onPhase as never
        return capture.promise
      }),
    })
    const started = controller.start()
    await flush()
    expect(deps.overlay.open).not.toHaveBeenCalled()

    emitConsent({ ...consentEvent, surface: "computerUse", id: "other" })
    emitConsent(consentEvent)
    await flush()
    expect(deps.overlay.open).toHaveBeenCalledWith(null)
    expect(views.at(-1)).toEqual({
      phase: "consent",
      runId: 1,
      consent: { id: "c1", processName: "WeChat", windowTitle: "Ann", expiresAt: 91_000 },
    })

    await controller.handleIntent({
      kind: "consent",
      id: "c1",
      allow: true,
      grantDurationMs: 300_000,
    })
    expect(deps.consent.settle).toHaveBeenCalledWith("c1")
    expect(deps.consent.respond).toHaveBeenCalledWith(
      expect.objectContaining({ id: "c1", allow: true, persist: true, grantDurationMs: 300_000 })
    )
    expect(views.at(-1)).toEqual({ phase: "capturing", runId: 1 })

    onPhase?.("reading", anchor)
    capture.resolve(read)
    await started
    await flush()
    expect(deps.overlay.place).toHaveBeenCalledWith(anchor)
    expect(views.at(-1)?.phase).toBe("done")
  })

  it("allows once without persisting a grant", async () => {
    const capture = deferred<ScreenRead>()
    const { controller, deps, emitConsent } = harness({ read: jest.fn(() => capture.promise) })
    void controller.start()
    await flush()
    emitConsent(consentEvent)
    await flush()
    await controller.handleIntent({ kind: "consent", id: "c1", allow: true })
    expect(deps.consent.respond).toHaveBeenCalledWith({ id: "c1", allow: true })
    capture.resolve(read)
  })

  it("explains a declined capture in the overlay", async () => {
    const { controller, views } = harness({
      read: jest.fn(async () => Promise.reject(new ScreenCopilotError("declined"))),
    })
    await controller.start()
    expect(views.at(-1)).toEqual({ phase: "error", runId: 1, error: "declined" })
  })

  it("hands the prompt back to the main window when the overlay cannot open", async () => {
    const capture = deferred<ScreenRead>()
    const { controller, deps, views, release, emitConsent } = harness({
      read: jest.fn(() => capture.promise),
      overlay: {
        open: jest.fn(async () => false),
        place: jest.fn(),
        close: jest.fn(),
        send: jest.fn(async () => true),
      },
    })
    void controller.start()
    await flush()
    emitConsent(consentEvent)
    await flush()
    expect(release).toHaveBeenCalled()
    expect(deps.onOverlayUnavailable).toHaveBeenCalledTimes(1)
    expect(views).toEqual([])
    capture.reject(new ScreenCopilotError("declined"))
  })

  it("rejects a pending prompt and releases the claim on close", async () => {
    const capture = deferred<ScreenRead>()
    const { controller, deps, release, emitConsent } = harness({
      read: jest.fn(() => capture.promise),
    })
    void controller.start()
    await flush()
    emitConsent(consentEvent)
    await flush()
    await controller.handleIntent({ kind: "close" })
    expect(deps.consent.respond).toHaveBeenCalledWith({ id: "c1", allow: false })
    expect(deps.consent.settle).toHaveBeenCalledWith("c1")
    expect(release).toHaveBeenCalled()
    expect(deps.overlay.close).toHaveBeenCalled()
    capture.reject(new DOMException("aborted", "AbortError"))
  })

  it("re-drafts from the same read with the user's instructions", async () => {
    const { controller, deps, views } = harness()
    await controller.start()
    await controller.handleIntent({ kind: "redraft", instructions: "say 3pm" })
    expect(deps.read).toHaveBeenCalledTimes(1)
    expect(deps.draft).toHaveBeenLastCalledWith(
      read,
      null,
      expect.objectContaining({ instructions: "say 3pm" })
    )
    expect(views.at(-1)).toMatchObject({ phase: "done", instructions: "say 3pm" })
  })

  it("reports a failed draft without losing the read", async () => {
    const { controller, views } = harness({
      draft: jest.fn(async () => Promise.reject(new Error("x"))),
    })
    await controller.start()
    expect(views.at(-1)).toMatchObject({
      phase: "error",
      error: "draft_failed",
      read: { appName: "WeChat" },
    })
  })

  it("re-sends the current view when the overlay mounts, and ignores a superseded run", async () => {
    const slow = deferred<ScreenRead>()
    const reads = [slow.promise, Promise.resolve(read)]
    const { controller, deps, views } = harness({ read: jest.fn(() => reads.shift()!) })
    void controller.start()
    await flush()
    await controller.start()
    slow.resolve({ ...read, bubbleCount: 99 })
    await flush()
    expect(views.filter((view) => view.phase === "done")).toHaveLength(1)
    expect(views.at(-1)).toMatchObject({ runId: 2, read: { bubbleCount: 3 } })

    ;(deps.overlay.send as jest.Mock).mockClear()
    await controller.handleIntent({ kind: "ready" })
    expect(deps.overlay.send).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "done", runId: 2 })
    )
  })

  it("opens System Settings for the Screen Recording grant", async () => {
    const { controller, deps } = harness()
    await controller.handleIntent({ kind: "openScreenRecordingSettings" })
    expect(deps.openScreenRecordingSettings).toHaveBeenCalled()
  })
})
