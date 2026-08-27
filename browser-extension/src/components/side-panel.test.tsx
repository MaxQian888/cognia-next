/** @jest-environment jsdom */
// `disconnect` clears the device key, which lives in IndexedDB — absent from
// jsdom, so without this the button throws instead of unpairing.
import "fake-indexeddb/auto"

import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import type {
  BrowserCompanionCapabilityV1,
  BrowserContextSubmissionSummaryV1,
} from "@cognia/companion-client"

import type { BrowserApi } from "@ext/src/lib/browser-api"
import { STORAGE_KEYS } from "@ext/src/lib/browser-api"
import { CAPTURE_REQUEST_KEY } from "@ext/src/lib/capture/capture-request"
import { SidePanel } from "./side-panel"

const CAPABILITY: BrowserCompanionCapabilityV1 = {
  schemaVersion: 1,
  limits: {
    instructionBytes: 8192,
    selectionBytes: 32768,
    readableTextBytes: 131072,
    requestBytes: 196608,
  },
  supportedCaptureModes: ["metadata", "selection", "readable-page"],
  workspaces: [
    { id: "ws-default", label: "Default", isDefault: true },
    { id: "ws-other", label: "Other", isDefault: false },
  ],
  appearance: {
    mode: "light",
    cssVars: { "--background": "oklch(1 0 0)" },
    radiusBaseRem: 0.625,
    pillRadiusPx: 9999,
    density: "comfortable",
  },
}

interface Harness {
  api: BrowserApi
  store: Map<string, unknown>
  submitAttempts: unknown[]
  submitted: unknown[]
  recent: BrowserContextSubmissionSummaryV1[]
  capabilityError?: unknown
  submitError?: unknown
}

function harness(overrides: Partial<Harness> = {}): Harness & { makeClient: never } {
  const store = new Map<string, unknown>(overrides.store ?? [])
  const state: Harness = {
    submitAttempts: [],
    submitted: [],
    recent: [],
    ...overrides,
    // After the spread, not before: `overrides` carries its own `store`, and
    // letting it win here would leave the harness reading one Map while the
    // api wrote to another.
    store,
    api: {
      activeTab: async () => ({ id: 1, url: "https://example.com/a?x=1", title: "A page" }),
      tabById: async (id) => ({ id, url: `https://example.com/tab-${id}`, title: `Tab ${id}` }),
      extract: async () => ({
        title: "A page",
        url: "https://example.com/a?x=1",
        selection: "the selected sentence",
        readableText: null,
        readableCharacterCount: 0,
      }),
      read: async (key) => (store.get(key) ?? null) as never,
      write: async (key, value) => {
        store.set(key, value)
      },
      remove: async (keys) => {
        for (const key of keys) store.delete(key)
      },
      hasLoopbackPermission: async () => true,
      requestLoopbackPermission: async () => true,
      extensionOrigin: () => "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
      openUrl: async () => undefined,
      message: (key) => key,
      ...overrides.api,
    },
  }
  return state as never
}

function clientFactory(state: Harness) {
  return () => ({
    capability: async () => {
      if (state.capabilityError) throw state.capabilityError
      return CAPABILITY
    },
    submit: async (request: unknown) => {
      state.submitAttempts.push(request)
      if (state.submitError) throw state.submitError
      state.submitted.push(request)
      return {
        submissionId: "sub-1",
        sessionId: "session-1",
        acceptedAt: 1,
        status: "queued" as const,
        deepLink: "cognia://session/session-1",
      }
    },
    list: async () => ({ items: state.recent }),
    invalidate: () => undefined,
  })
}

const PAIRING = {
  baseUrl: "http://127.0.0.1:27891",
  tenantId: "tenant-a",
  deviceId: "browser-a",
  extensionOrigin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
  pairedAt: 1,
}

jest.mock("@ext/src/lib/client", () => {
  const actual = jest.requireActual("@ext/src/lib/client")
  return {
    ...actual,
    restoreSigner: async () => ({ deviceId: "browser-a", sign: async () => new Uint8Array() }),
  }
})

function renderPanel(state: Harness) {
  return render(
    <SidePanel api={state.api} makeClient={clientFactory(state) as never} now={() => 1_000} />
  )
}

describe("SidePanel", () => {
  it("asks to pair when this browser has no pairing", async () => {
    const state = harness()
    renderPanel(state)
    await screen.findByText("pairTitle")
  })

  it("shows the capture screen once paired", async () => {
    const state = harness({ store: new Map([[STORAGE_KEYS.pairing, PAIRING]]) as never })
    renderPanel(state)
    await screen.findByText("captureTitle")
    // Nothing is captured on open: the panel is visible constantly, and
    // reading the page just because it is there is the behaviour the design
    // forbids.
    await screen.findByTestId("capture-empty")
  })

  it("distinguishes a revoked device from an unreachable Host", async () => {
    const revoked = harness({
      store: new Map([[STORAGE_KEYS.pairing, PAIRING]]) as never,
      capabilityError: Object.assign(new Error("gone"), { code: "device_unavailable" }),
    })
    const { unmount } = renderPanel(revoked)
    await screen.findByTestId("panel-revoked")
    unmount()

    const offline = harness({
      store: new Map([[STORAGE_KEYS.pairing, PAIRING]]) as never,
      capabilityError: new Error("fetch failed"),
    })
    renderPanel(offline)
    await screen.findByTestId("panel-offline")
  })

  it("refuses a Host whose schema this build does not implement", async () => {
    const state = harness({ store: new Map([[STORAGE_KEYS.pairing, PAIRING]]) as never })
    const factory = () => ({
      ...clientFactory(state)(),
      capability: async () => ({ ...CAPABILITY, schemaVersion: 99 }),
    })
    render(<SidePanel api={state.api} makeClient={factory as never} now={() => 1_000} />)
    await screen.findByTestId("panel-incompatible")
  })

  it("applies and caches the Host's appearance", async () => {
    // Cached so a panel reopened offline still looks like the app instead of
    // flashing the fallback palette and then correcting itself.
    const state = harness({ store: new Map([[STORAGE_KEYS.pairing, PAIRING]]) as never })
    renderPanel(state)
    await screen.findByText("captureTitle")
    await waitFor(() => expect(state.store.get(STORAGE_KEYS.appearance)).toBeDefined())
    expect(document.documentElement.style.getPropertyValue("--background")).toBe("oklch(1 0 0)")
  })

  it("shows the recent list, and offers to continue rather than to approve", async () => {
    const state = harness({
      store: new Map([[STORAGE_KEYS.pairing, PAIRING]]) as never,
      recent: [
        {
          submissionId: "sub-1",
          sessionId: "session-1",
          title: "Pricing research",
          sourceHost: "example.com",
          captureMode: "selection",
          status: "needs_input",
          submittedAt: 1,
          updatedAt: 2,
          deepLink: "cognia://session/session-1",
        },
      ],
    })
    renderPanel(state)
    await screen.findByTestId("recent-list")
    expect(screen.getByText("Pricing research")).toBeInTheDocument()
    // The panel cannot answer a prompt (ADR-0154 §1), so it never renders
    // something that looks like it could.
    await screen.findByText("continueInCognia")
    expect(screen.queryByText(/approve/i)).toBeNull()
  })
})

describe("SidePanel capture and settings", () => {
  it("offers a capture button, because opening the panel captures nothing", async () => {
    // The panel is visible constantly; reading the page just because it is
    // there is the behaviour the design forbids. So the user asks.
    const state = harness({ store: new Map([[STORAGE_KEYS.pairing, PAIRING]]) as never })
    renderPanel(state)
    await screen.findByTestId("capture-now")
    await screen.findByTestId("capture-whole-page")
  })

  it("captures the selection when asked, and previews it before sending", async () => {
    const state = harness({ store: new Map([[STORAGE_KEYS.pairing, PAIRING]]) as never })
    renderPanel(state)
    fireEvent.click(await screen.findByTestId("capture-now"))
    await screen.findByTestId("capture-preview")
    // The address the user is agreeing to, with the query string gone.
    expect(screen.getByTestId("capture-url")).toHaveTextContent("https://example.com/a")
    expect(screen.getByTestId("capture-url")).not.toHaveTextContent("x=1")
  })

  it("explains a missing activeTab grant instead of failing silently", async () => {
    // Switching tabs with the panel open is the ordinary way to arrive here.
    const state = harness({
      store: new Map([[STORAGE_KEYS.pairing, PAIRING]]) as never,
      api: {
        extract: async () => {
          throw new Error("Cannot access contents of the page")
        },
      } as never,
    })
    renderPanel(state)
    fireEvent.click(await screen.findByTestId("capture-now"))
    await waitFor(() =>
      expect(screen.getByTestId("submit-error")).toHaveTextContent("captureNoGrant")
    )
  })

  it("refuses to capture a page that is not http(s)", async () => {
    const state = harness({
      store: new Map([[STORAGE_KEYS.pairing, PAIRING]]) as never,
      api: {
        activeTab: async () => ({ id: 1, url: "chrome://settings", title: "Settings" }),
      } as never,
    })
    renderPanel(state)
    fireEvent.click(await screen.findByTestId("capture-now"))
    await waitFor(() =>
      expect(screen.getByTestId("submit-error")).toHaveTextContent("captureRestricted")
    )
    expect(screen.queryByTestId("capture-preview")).toBeNull()
  })

  it("submits the captured page and clears the draft", async () => {
    const state = harness({ store: new Map([[STORAGE_KEYS.pairing, PAIRING]]) as never })
    renderPanel(state)
    fireEvent.click(await screen.findByTestId("capture-now"))
    await screen.findByTestId("capture-preview")
    fireEvent.change(screen.getByTestId("instruction"), {
      target: { value: "Summarise the pricing" },
    })
    fireEvent.click(screen.getByTestId("submit"))

    await waitFor(() => expect(state.submitted).toHaveLength(1))
    const request = state.submitted[0] as Record<string, unknown>
    expect(request.instruction).toBe("Summarise the pricing")
    expect(request.workspaceId).toBe("ws-default")
    // Cleared afterwards: a preview left on screen after a successful submit
    // invites the user to send the same page twice.
    await waitFor(() => expect(screen.queryByTestId("capture-preview")).toBeNull())
  })

  it("submits the same URL shown after the full-address toggle changes", async () => {
    const state = harness({ store: new Map([[STORAGE_KEYS.pairing, PAIRING]]) as never })
    renderPanel(state)
    fireEvent.click(await screen.findByTestId("capture-now"))
    await screen.findByTestId("capture-preview")
    fireEvent.click(screen.getByTestId("capture-full-url"))
    expect(screen.getByTestId("capture-url")).toHaveTextContent("https://example.com/a?x=1")
    fireEvent.change(screen.getByTestId("instruction"), { target: { value: "Go" } })
    fireEvent.click(screen.getByTestId("submit"))

    await waitFor(() => expect(state.submitted).toHaveLength(1))
    expect((state.submitted[0] as { context: { url: string } }).context.url).toBe(
      "https://example.com/a?x=1"
    )
  })

  it("reuses the submission id when the user retries the same draft", async () => {
    const state = harness({
      store: new Map([[STORAGE_KEYS.pairing, PAIRING]]) as never,
      submitError: new Error("response lost"),
    })
    renderPanel(state)
    fireEvent.click(await screen.findByTestId("capture-now"))
    await screen.findByTestId("capture-preview")
    fireEvent.change(screen.getByTestId("instruction"), { target: { value: "Go" } })
    fireEvent.click(screen.getByTestId("submit"))
    await waitFor(() => expect(state.submitAttempts).toHaveLength(1))

    state.submitError = undefined
    fireEvent.click(screen.getByTestId("submit"))
    await waitFor(() => expect(state.submitAttempts).toHaveLength(2))
    expect(
      state.submitAttempts.map((attempt) => (attempt as { submissionId: string }).submissionId)
    ).toEqual([
      (state.submitAttempts[0] as { submissionId: string }).submissionId,
      (state.submitAttempts[0] as { submissionId: string }).submissionId,
    ])
  })

  it("shows a recoverable error when extension storage cannot be read", async () => {
    const state = harness({
      api: { read: async () => Promise.reject(new Error("storage unavailable")) } as never,
    })
    renderPanel(state)
    expect(await screen.findByTestId("panel-storage-error")).toBeInTheDocument()
  })

  it("will not submit without an instruction", async () => {
    const state = harness({ store: new Map([[STORAGE_KEYS.pairing, PAIRING]]) as never })
    renderPanel(state)
    fireEvent.click(await screen.findByTestId("capture-now"))
    await screen.findByTestId("capture-preview")
    expect(screen.getByTestId("submit")).toBeDisabled()
  })

  it("remembers the chosen workspace for next time", async () => {
    const state = harness({ store: new Map([[STORAGE_KEYS.pairing, PAIRING]]) as never })
    renderPanel(state)
    fireEvent.click(await screen.findByTestId("capture-now"))
    await screen.findByTestId("capture-preview")
    fireEvent.change(screen.getByTestId("instruction"), { target: { value: "Go" } })
    fireEvent.click(screen.getByTestId("submit"))
    await waitFor(() => expect(state.store.get(STORAGE_KEYS.lastWorkspaceId)).toBe("ws-default"))
  })

  it("names the Host it is talking to", async () => {
    const state = harness({ store: new Map([[STORAGE_KEYS.pairing, PAIRING]]) as never })
    renderPanel(state)
    expect(await screen.findByTestId("diagnostics")).toHaveTextContent("http://127.0.0.1:27891")
  })

  it("forgets everything on disconnect", async () => {
    const state = harness({ store: new Map([[STORAGE_KEYS.pairing, PAIRING]]) as never })
    renderPanel(state)
    fireEvent.click(await screen.findByTestId("disconnect"))
    await screen.findByText("pairTitle")
    expect(state.store.get(STORAGE_KEYS.pairing)).toBeUndefined()
  })

  it("clears the local conveniences without unpairing", async () => {
    // The recent list is the Host's and comes back on the next poll; what goes
    // is the cached appearance and the remembered workspace.
    const state = harness({ store: new Map([[STORAGE_KEYS.pairing, PAIRING]]) as never })
    renderPanel(state)
    await screen.findByTestId("clear-local")
    await waitFor(() => expect(state.store.get(STORAGE_KEYS.appearance)).toBeDefined())
    fireEvent.click(screen.getByTestId("clear-local"))
    await waitFor(() => expect(state.store.get(STORAGE_KEYS.appearance)).toBeUndefined())
    expect(state.store.get(STORAGE_KEYS.pairing)).toBeDefined()
  })

  it("captures the tab the gesture named, not whichever is active now", async () => {
    // The background worker records a tab id precisely because the two moments
    // are not the same one: a context-menu click happens in the worker, which
    // opens a panel that may be starting from nothing, and by the time it
    // mounts the active tab can be a different page — or, when the panel is
    // rendered as a tab, the panel itself. Re-querying the active tab throws
    // away the only record of what the user pointed at.
    const state = harness({
      store: new Map<string, unknown>([
        [STORAGE_KEYS.pairing, PAIRING],
        [CAPTURE_REQUEST_KEY, { tabId: 42, mode: "selection", requestedAt: 1_000 }],
      ]) as never,
      api: {
        activeTab: async () => ({ id: 1, url: "https://elsewhere.example/", title: "Elsewhere" }),
      } as never,
    })
    renderPanel(state)

    expect(await screen.findByTestId("capture-url")).toHaveTextContent("https://example.com/tab-42")
    // And consumed, so reopening the panel does not re-read a page nobody
    // asked about a second time.
    await waitFor(() => expect(state.store.get(CAPTURE_REQUEST_KEY)).toBeUndefined())
  })

  it("says so when the recorded tab has closed", async () => {
    const state = harness({
      store: new Map<string, unknown>([
        [STORAGE_KEYS.pairing, PAIRING],
        [CAPTURE_REQUEST_KEY, { tabId: 42, mode: "page", requestedAt: 1_000 }],
      ]) as never,
      api: { tabById: async () => null } as never,
    })
    renderPanel(state)
    expect(await screen.findByTestId("submit-error")).toBeInTheDocument()
  })
})
