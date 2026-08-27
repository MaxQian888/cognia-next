/** @jest-environment jsdom */
import { render, screen, waitFor } from "@testing-library/react"

import type {
  BrowserCompanionCapabilityV1,
  BrowserContextSubmissionSummaryV1,
} from "@cognia/companion-client"

import type { BrowserApi } from "@ext/src/lib/browser-api"
import { STORAGE_KEYS } from "@ext/src/lib/browser-api"
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
  submitted: unknown[]
  recent: BrowserContextSubmissionSummaryV1[]
  capabilityError?: unknown
  submitError?: unknown
}

function harness(overrides: Partial<Harness> = {}): Harness & { makeClient: never } {
  const store = new Map<string, unknown>(overrides.store ?? [])
  const state: Harness = {
    submitted: [],
    recent: [],
    ...overrides,
    // After the spread, not before: `overrides` carries its own `store`, and
    // letting it win here would leave the harness reading one Map while the
    // api wrote to another.
    store,
    api: {
      activeTab: async () => ({ id: 1, url: "https://example.com/a?x=1", title: "A page" }),
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
