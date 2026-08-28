import {
  APPEARANCE_OVERRIDES,
  POLL_ACTIVE_MS,
  POLL_IDLE_MS,
  STATUSES_WITH_A_REASON,
  SUPPORTED_SCHEMA_VERSION,
  appearanceOverrideMessage,
  captureModeFor,
  failureReasonMessage,
  isAppearanceOverride,
  isCompatible,
  panelStateForError,
  pollIntervalFor,
  preferredModeFor,
  selectedTargetId,
  targetLabel,
  targetsForWorkspace,
  type CapturedPage,
} from "./panel-state"
import type { PairingRecord } from "./client"

const PAIRING: PairingRecord = {
  baseUrl: "http://127.0.0.1:27891",
  tenantId: "tenant-a",
  deviceId: "browser-a",
  extensionOrigin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
  pairedAt: 1,
}

function page(overrides: Partial<CapturedPage> = {}): CapturedPage {
  return {
    tabId: 1,
    title: "A",
    url: "https://example.com/a",
    rawUrl: "https://example.com/a?x=1",
    selection: null,
    readableText: null,
    capturedAt: 1,
    strippedQuery: true,
    ...overrides,
  }
}

describe("panelStateForError", () => {
  it("treats a revoked device and a wrong origin as terminal", () => {
    // Both mean the Host will not talk to this browser again; only re-pairing
    // fixes either, so a retry button would be a lie.
    for (const code of ["device_unavailable", "device_origin_mismatch"]) {
      expect(panelStateForError({ code }, PAIRING)).toEqual({ kind: "revoked" })
    }
  })

  it("treats everything else as the Host being unreachable", () => {
    // A network blip must not throw away a working pairing.
    expect(panelStateForError(new Error("fetch failed"), PAIRING)).toEqual({
      kind: "host-offline",
      pairing: PAIRING,
    })
    expect(panelStateForError({ code: "rate_limited" }, PAIRING)).toMatchObject({
      kind: "host-offline",
    })
  })
})

describe("isCompatible", () => {
  it("accepts only the schema version this build implements", () => {
    expect(isCompatible({ schemaVersion: SUPPORTED_SCHEMA_VERSION })).toBe(true)
    expect(isCompatible({ schemaVersion: SUPPORTED_SCHEMA_VERSION + 1 })).toBe(false)
    expect(isCompatible({ schemaVersion: 0 })).toBe(false)
  })
})

describe("captureModeFor", () => {
  it("prefers a selection, because the user already pointed at it", () => {
    expect(captureModeFor(page({ selection: { text: "x", truncated: false } }), false)).toBe(
      "selection"
    )
  })

  it("only ever sends the whole page on an explicit request", () => {
    const withBody = page({
      readableText: { text: "body", truncated: false, originalCharacterCount: 4 },
    })
    expect(captureModeFor(withBody, false)).toBe("metadata")
    expect(captureModeFor(withBody, true)).toBe("readable-page")
  })

  it("falls back to metadata when there is nothing else", () => {
    expect(captureModeFor(page(), true)).toBe("metadata")
  })
})

describe("pollIntervalFor", () => {
  it("polls fast while anything is in flight", () => {
    for (const status of ["submitting", "queued", "running", "needs_input"]) {
      expect(pollIntervalFor([{ status }])).toBe(POLL_ACTIVE_MS)
    }
  })

  it("backs off once everything is finished", () => {
    // A settled list is history, and history does not change; polling it every
    // three seconds is a request per user per three seconds for nothing.
    expect(pollIntervalFor([{ status: "completed" }, { status: "failed" }])).toBe(POLL_IDLE_MS)
    expect(pollIntervalFor([])).toBe(POLL_IDLE_MS)
  })

  it("polls fast when even one entry is still moving", () => {
    expect(pollIntervalFor([{ status: "completed" }, { status: "running" }])).toBe(POLL_ACTIVE_MS)
  })
})

describe("failureReasonMessage", () => {
  const message = (key: string, subs?: string[]) => (subs ? `${key}:${subs.join(",")}` : key)

  it("explains the codes a browser can actually meet", () => {
    expect(failureReasonMessage("runtime_target_unavailable", message)).toBe("reasonNoRuntime")
    expect(failureReasonMessage("enqueue_refused", message)).toBe("reasonRefused")
    expect(failureReasonMessage("enqueue_failed", message)).toBe("reasonRefused")
  })

  it("frames an unknown code as something Cognia said, not as prose", () => {
    // A code is a machine token. Rendering `some_new_code` bare would read as
    // an error message the extension wrote, which is how an enum ends up on
    // screen pretending to be a sentence.
    expect(failureReasonMessage("some_new_code", message)).toBe("reasonOther:some_new_code")
  })

  it("asks for a reason only where one can exist", () => {
    // Every other status either has not failed or failed inside the run, where
    // the row carries no `errorCode` to fetch.
    expect([...STATUSES_WITH_A_REASON].sort()).toEqual(["failed", "host_unavailable"])
  })
})

describe("delivery targets", () => {
  const NEW_TASK = { id: "chat:new", kind: "chat" as const, label: "New task", isDefault: true }
  const IN_DEFAULT = {
    id: "session:a",
    kind: "session" as const,
    label: "A guide",
    isDefault: false,
    workspaceId: "ws-default",
  }
  const IN_OTHER = { ...IN_DEFAULT, id: "session:b", workspaceId: "ws-other" }

  it("offers a workspace-less target everywhere and a bound one only where it lives", () => {
    // A new task is created in whichever workspace is selected; a conversation
    // already lives in one, and the submission does not move it.
    expect(
      targetsForWorkspace([NEW_TASK, IN_DEFAULT, IN_OTHER], "ws-default").map((t) => t.id)
    ).toEqual(["chat:new", "session:a"])
  })

  it("treats an older Host that sends none as new-tasks-only", () => {
    expect(targetsForWorkspace(undefined, "ws-default")).toEqual([])
  })

  it("drops a selection the new workspace does not offer", () => {
    // Keeping it would send a `targetId` the Host refuses — correctly, and
    // inexplicably to somebody who only changed the workspace.
    const offered = targetsForWorkspace([NEW_TASK, IN_DEFAULT, IN_OTHER], "ws-other")
    expect(selectedTargetId(offered, "session:a")).toBe("chat:new")
    expect(selectedTargetId(offered, "session:b")).toBe("session:b")
  })

  it("falls back to the Host's default rather than to list order", () => {
    expect(selectedTargetId([IN_DEFAULT, NEW_TASK], null)).toBe("chat:new")
    expect(selectedTargetId([], null)).toBeNull()
  })

  it("localizes the chrome and passes through the user's own data", () => {
    const message = (key: string) => `i18n:${key}`
    expect(targetLabel(NEW_TASK, message)).toBe("i18n:targetNewTask")
    expect(targetLabel(IN_DEFAULT, message)).toBe("A guide")
  })
})

describe("appearance override", () => {
  it("names three choices and recognises only those", () => {
    expect([...APPEARANCE_OVERRIDES]).toEqual(["follow-host", "light", "dark"])
    expect(isAppearanceOverride("light")).toBe(true)
    // What a corrupted or older stored value looks like. It must fall back to
    // following the Host rather than being applied as a mode.
    expect(isAppearanceOverride("system")).toBe(false)
    expect(isAppearanceOverride(undefined)).toBe(false)
  })

  it("labels each choice from a literal key the coverage gate can find", () => {
    const message = (key: string) => `i18n:${key}`
    expect(appearanceOverrideMessage("follow-host", message)).toBe("i18n:appearanceFollowHost")
    expect(appearanceOverrideMessage("light", message)).toBe("i18n:appearanceLight")
    expect(appearanceOverrideMessage("dark", message)).toBe("i18n:appearanceDark")
  })
})

describe("preferredModeFor", () => {
  it("sends the forced mode, whatever the Host or the system say", () => {
    expect(preferredModeFor("dark", true, false)).toBe("dark")
    expect(preferredModeFor("light", false, true)).toBe("light")
  })

  it("leaves the Host's own setting alone when it has one", () => {
    // Sending a mode here would override a choice the user already made in
    // Cognia, from a panel that is set to follow it.
    expect(preferredModeFor("follow-host", false, true)).toBeUndefined()
  })

  it("answers for the Host when the Host is following the system", () => {
    // The one thing the Host cannot see. Before this it resolved `system` to
    // dark for everyone, including people whose system is light.
    expect(preferredModeFor("follow-host", true, true)).toBe("dark")
    expect(preferredModeFor("follow-host", true, false)).toBe("light")
  })

  it("says nothing until the Host has answered once", () => {
    // `followsSystem` arrives with the first capability response, so the first
    // call of a session cannot carry it.
    expect(preferredModeFor("follow-host", undefined, true)).toBeUndefined()
  })
})
