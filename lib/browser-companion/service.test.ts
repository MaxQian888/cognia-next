import type { BrowserSubmissionRow } from "@/lib/db/browser-submissions-types"
import type { ChatTemplateRow } from "@/lib/db/chat-templates"

import {
  BrowserCompanionError,
  browserCompanionCapability,
  cancelBrowserContext,
  getBrowserContextResult,
  browserSubmissionDeepLink,
  getBrowserContextSubmission,
  listBrowserContextSubmissions,
  submitBrowserContext,
  SECOND_CLAIMANT_CODE,
  type BrowserCompanionDeps,
} from "./service"
import { listDeliveryTargets } from "./targets"

const APPEARANCE = {
  mode: "dark" as const,
  cssVars: { "--background": "oklch(0.145 0 0)" },
  radiusBaseRem: 0.625,
  pillRadiusPx: 9999,
  density: "comfortable" as const,
}

interface Harness {
  deps: BrowserCompanionDeps
  rows: Map<string, BrowserSubmissionRow>
  createdSessions: { title: string; projectId: string }[]
  enqueued: { sessionId: string; messageId: string; text: string }[]
  statuses: Map<string, BrowserSubmissionRow["status"]>
  sessionStatusThrows: boolean
  followsSystem: boolean
  answers: Map<string, { text: string; at: number }>
  aborted: string[]
  filedIssues: unknown[]
  startedTasks: unknown[]
  workStatuses: Map<string, BrowserSubmissionRow["status"]>
  abortRefused: boolean
  /** The rejection code the refused abort answers with. */
  abortRefusalCode: string
  /** The Host's templates, mutable so a test can delete one mid-flight. */
  templates: ChatTemplateRow[]
  /** Every `renderTemplate` call — the harness's stand-in for `recordChatTemplateUse`. */
  renderedTemplates: string[]
}

function harness(
  overrides: Partial<BrowserCompanionDeps> & {
    templates?: ChatTemplateRow[]
    boards?: { id: string; name: string; workspaceId: string }[]
    agents?: { id: string; name: string }[]
  } = {}
): Harness {
  const rows = new Map<string, BrowserSubmissionRow>()
  const createdSessions: Harness["createdSessions"] = []
  const enqueued: Harness["enqueued"] = []
  const statuses = new Map<string, BrowserSubmissionRow["status"]>()
  const templates: ChatTemplateRow[] = overrides.templates ?? []
  const boards = overrides.boards ?? []
  const agents = overrides.agents ?? []
  const filedIssues: unknown[] = []
  const startedTasks: unknown[] = []
  const workStatuses = new Map<string, BrowserSubmissionRow["status"]>()
  const answers = new Map<string, { text: string; at: number }>()
  const aborted: string[] = []
  const renderedTemplates: string[] = []
  const state = {
    sessionStatusThrows: false,
    followsSystem: false,
    abortRefused: false,
    abortRefusalCode: SECOND_CLAIMANT_CODE,
  }
  let sessionCounter = 0
  const deps: BrowserCompanionDeps = {
    now: () => 1_700_000_000_000,
    listWorkspaces: async () => [
      { id: "ws-default", label: "Default", isDefault: true },
      { id: "ws-other", label: "Other", isDefault: false },
    ],
    appearance: async (preferredMode) => ({
      appearance: { ...APPEARANCE, mode: preferredMode ?? APPEARANCE.mode },
      followsSystem: state.followsSystem,
    }),
    createSession: async (input) => {
      createdSessions.push(input)
      sessionCounter += 1
      return { id: `session-${sessionCounter}` }
    },
    enqueueMessage: async (input) => {
      enqueued.push(input)
    },
    recordSubmission: async (row) => {
      rows.set(row.submissionId, row)
    },
    readSubmission: async (id) => rows.get(id),
    listSubmissions: async (deviceId, limit) =>
      [...rows.values()]
        .filter((row) => row.deviceId === deviceId)
        .sort((left, right) => right.submittedAt - left.submittedAt)
        .slice(0, limit),
    // The real catalogue over the harness's rows. Stubbing it would make every
    // "the target must be one the Host offered" assertion vacuous, since the
    // stub would be the thing deciding what was offered.
    listDeliveryTargets: async (deviceId) =>
      listDeliveryTargets(
        {
          listSubmissions: async (id, limit) =>
            [...rows.values()]
              .filter((row) => row.deviceId === id)
              .sort((left, right) => right.submittedAt - left.submittedAt)
              .slice(0, limit),
          listTemplates: async () => templates,
          listIssueProjects: async () => boards,
          listTaskAgents: async () => agents,
        },
        deviceId
      ),
    createIssue: async (input) => {
      filedIssues.push(input)
      return { id: `issue-${filedIssues.length}` }
    },
    createAgentTask: async (input) => {
      startedTasks.push(input)
      return { id: `agent-task-${startedTasks.length}` }
    },
    workStatus: async (_kind, workId) => workStatuses.get(workId) ?? null,
    renderTemplate: async (templateId, values) => {
      // Counted, because the real one records the use on the way out — so a
      // render that should not have happened is a write that should not have
      // happened.
      renderedTemplates.push(templateId)
      const found = templates.find((entry) => entry.id === templateId)
      if (!found) return null
      const missing = found.params
        .filter((param) => param.required && !values[param.id]?.trim())
        .map((param) => param.label)
      if (missing.length > 0) return { text: "", missing }
      let text = found.body
      for (const [id, value] of Object.entries(values)) {
        if (!found.params.some((param) => param.id === id)) continue
        text = text.split(`{{${id}}}`).join(value)
      }
      return { text, missing: [] }
    },
    sessionStatus: async (sessionId) => {
      if (state.sessionStatusThrows) throw new Error("runtime unreachable")
      return statuses.get(sessionId) ?? "running"
    },
    capabilityRevision: async () => "rev-1",
    latestAnswer: async (sessionId) => answers.get(sessionId) ?? null,
    abortTurn: async (sessionId) => {
      aborted.push(sessionId)
      return state.abortRefused
        ? { stopped: false, reasonCode: state.abortRefusalCode }
        : { stopped: true }
    },
    ...overrides,
  }
  return {
    deps,
    rows,
    createdSessions,
    enqueued,
    statuses,
    answers,
    aborted,
    filedIssues,
    startedTasks,
    workStatuses,
    templates,
    renderedTemplates,
    get sessionStatusThrows() {
      return state.sessionStatusThrows
    },
    set sessionStatusThrows(value: boolean) {
      state.sessionStatusThrows = value
    },
    get followsSystem() {
      return state.followsSystem
    },
    set followsSystem(value: boolean) {
      state.followsSystem = value
    },
    get abortRefused() {
      return state.abortRefused
    },
    set abortRefused(value: boolean) {
      state.abortRefused = value
    },
    get abortRefusalCode() {
      return state.abortRefusalCode
    },
    set abortRefusalCode(value: string) {
      state.abortRefusalCode = value
    },
  }
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    submissionId: "sub-1",
    workspaceId: "ws-default",
    instruction: "Summarise the pricing",
    context: {
      schemaVersion: 1,
      captureMode: "selection",
      url: "https://example.com/pricing",
      title: "Pricing",
      capturedAt: 1_699_000_000_000,
      selection: { text: "Team plan is $20", truncated: false },
    },
    ...overrides,
  }
}

describe("browserCompanionCapability", () => {
  it("describes the limits, modes, workspaces and appearance", async () => {
    const h = harness()
    const capability = await browserCompanionCapability(h.deps, "browser-a")
    expect(capability.schemaVersion).toBe(1)
    expect(capability.supportedCaptureModes).toEqual(["metadata", "selection", "readable-page"])
    expect(capability.workspaces[0]).toMatchObject({ id: "ws-default", isDefault: true })
    expect(capability.appearance).toEqual(APPEARANCE)
    expect(capability.limits.readableTextBytes).toBeGreaterThan(0)
  })
})

describe("submitBrowserContext", () => {
  it("creates the session in the chosen workspace and enqueues one message", async () => {
    const h = harness()
    const receipt = await submitBrowserContext(h.deps, "browser-a", payload())
    expect(h.createdSessions).toEqual([{ title: "Summarise the pricing", projectId: "ws-default" }])
    expect(h.enqueued).toHaveLength(1)
    expect(receipt).toMatchObject({
      submissionId: "sub-1",
      sessionId: "session-1",
      status: "queued",
      deepLink: "cognia://session/session-1",
    })
  })

  it("sends the fenced prompt, not the raw page", async () => {
    const h = harness()
    await submitBrowserContext(h.deps, "browser-a", payload())
    const text = h.enqueued[0].text
    expect(text.startsWith("Summarise the pricing")).toBe(true)
    expect(text).toContain("<untrusted_content>")
    expect(text).toContain("Team plan is $20")
  })

  it("derives the message id from the submission so a retry cannot double-post", async () => {
    const h = harness()
    await submitBrowserContext(h.deps, "browser-a", payload())
    expect(h.enqueued[0].messageId).toBe("browser-sub-1")
  })

  it("replays the original receipt instead of creating a second session", async () => {
    const h = harness()
    const first = await submitBrowserContext(h.deps, "browser-a", payload())
    const second = await submitBrowserContext(h.deps, "browser-a", payload())
    expect(second).toEqual(first)
    expect(h.createdSessions).toHaveLength(1)
    expect(h.enqueued).toHaveLength(1)
  })

  it("redrives the same message when the first enqueue did not finish", async () => {
    let fail = true
    const attempts: string[] = []
    const h = harness({
      enqueueMessage: async ({ messageId }) => {
        attempts.push(messageId)
        if (fail) throw new Error("HostState unavailable")
      },
    })

    await expect(submitBrowserContext(h.deps, "browser-a", payload())).rejects.toThrow(
      "HostState unavailable"
    )
    // The refusal is written down rather than left looking mid-flight, and
    // `failed` is still redrivable — which the next call proves.
    expect(h.rows.get("sub-1")).toMatchObject({ status: "failed", errorCode: "enqueue_failed" })

    fail = false
    await expect(submitBrowserContext(h.deps, "browser-a", payload())).resolves.toMatchObject({
      sessionId: "session-1",
      status: "queued",
    })
    expect(h.createdSessions).toHaveLength(1)
    expect(attempts).toEqual(["browser-sub-1", "browser-sub-1"])
    expect(h.rows.get("sub-1")?.status).toBe("queued")
    // The code described the attempt that failed, not the row. A row put back
    // with `errorCode: undefined` still carries the key and would be spread
    // onto every later status response.
    expect(h.rows.get("sub-1")).not.toHaveProperty("errorCode")
  })

  it("appends to a conversation this device started, without creating a second one", async () => {
    const h = harness()
    const first = await submitBrowserContext(h.deps, "browser-a", payload())
    const second = await submitBrowserContext(
      h.deps,
      "browser-a",
      payload({ submissionId: "sub-2", targetId: `session:${first.sessionId}` })
    )

    expect(second.sessionId).toBe(first.sessionId)
    expect(h.createdSessions).toHaveLength(1)
    expect(h.enqueued.map((entry) => entry.sessionId)).toEqual([first.sessionId, first.sessionId])
    // The conversation keeps its own title. Overwriting it with whatever page
    // was captured second would rename a task from under whoever is reading it.
    expect(h.rows.get("sub-2")?.title).toBe(h.rows.get("sub-1")?.title)
  })

  it("refuses a session the Host never offered this device", async () => {
    // The whole bound on the append path. `session:session-9` is a well-formed
    // id, and the only thing that stops a browser from naming a conversation it
    // did not start is that the Host did not put it in the catalogue.
    const h = harness()
    await expect(
      submitBrowserContext(h.deps, "browser-a", payload({ targetId: "session:session-9" }))
    ).rejects.toMatchObject({ code: "unknown_target" })
    expect(h.createdSessions).toHaveLength(0)
  })

  it("refuses another device's session even when it exists", async () => {
    const h = harness()
    const theirs = await submitBrowserContext(h.deps, "browser-b", payload())
    await expect(
      submitBrowserContext(
        h.deps,
        "browser-a",
        payload({ submissionId: "sub-2", targetId: `session:${theirs.sessionId}` })
      )
    ).rejects.toMatchObject({ code: "unknown_target" })
  })

  it("refuses a target that belongs to a different workspace", async () => {
    const h = harness()
    const first = await submitBrowserContext(h.deps, "browser-a", payload())
    await expect(
      submitBrowserContext(
        h.deps,
        "browser-a",
        payload({
          submissionId: "sub-2",
          workspaceId: "ws-other",
          targetId: `session:${first.sessionId}`,
        })
      )
    ).rejects.toMatchObject({ code: "unknown_target" })
  })

  it("treats a submission that names no target as a new task", async () => {
    // The wire contract keeps `targetId` optional so an extension built before
    // targets existed keeps working, and this is what that means.
    const h = harness()
    const response = await submitBrowserContext(h.deps, "browser-a", payload())
    expect(response.sessionId).toBe("session-1")
    expect(h.rows.get("sub-1")?.targetId).toBe("chat:new")
  })

  it("refuses a redrive that changes where the work goes", async () => {
    // Same id, same page, different destination. Every other field agrees, so
    // nothing else in `describesSameCapture` can tell these apart — and
    // honouring it would append to a task the caller asked to be created fresh.
    let fail = false
    const h = harness({
      enqueueMessage: async () => {
        if (fail) throw new Error("HostState unavailable")
      },
    })
    const seed = await submitBrowserContext(h.deps, "browser-a", payload({ submissionId: "seed" }))

    fail = true
    await expect(submitBrowserContext(h.deps, "browser-a", payload())).rejects.toThrow(
      "HostState unavailable"
    )

    fail = false
    await expect(
      submitBrowserContext(h.deps, "browser-a", payload({ targetId: `session:${seed.sessionId}` }))
    ).rejects.toMatchObject({ code: "submission_payload_mismatch" })
  })

  it("reports a missing runtime as host_unavailable rather than throwing", async () => {
    // The contract calls this "a real state, not an error": the session exists
    // and the capture is recorded, so the work is one runtime away from
    // running. Throwing would tell the user to resubmit it.
    let fail = true
    const h = harness({
      enqueueMessage: async () => {
        if (fail) throw new BrowserCompanionError("runtime_target_unavailable", "no runtime")
      },
    })
    await expect(submitBrowserContext(h.deps, "browser-a", payload())).resolves.toMatchObject({
      status: "host_unavailable",
      sessionId: "session-1",
    })
    expect(h.rows.get("sub-1")).toMatchObject({
      status: "host_unavailable",
      errorCode: "runtime_target_unavailable",
    })

    // And it stays redrivable, which is the whole reason it is not a failure.
    fail = false
    await expect(submitBrowserContext(h.deps, "browser-a", payload())).resolves.toMatchObject({
      status: "queued",
    })
    expect(h.createdSessions).toHaveLength(1)
  })

  it("refuses to redrive an in-flight submission id with a different capture", async () => {
    const h = harness({
      enqueueMessage: async () => {
        throw new Error("HostState unavailable")
      },
    })
    await expect(submitBrowserContext(h.deps, "browser-a", payload())).rejects.toThrow(
      "HostState unavailable"
    )
    expect(h.rows.get("sub-1")?.status).toBe("failed")

    // Same id, a different page. Letting it through would enqueue page B into
    // the session created (and titled) for page A, while the row kept
    // reporting A's host and byte count.
    const other = payload({
      context: {
        schemaVersion: 1,
        captureMode: "selection",
        url: "https://evil.test/other",
        title: "Other",
        capturedAt: 1_699_000_000_000,
        selection: { text: "something else entirely", truncated: false },
      },
    })
    await expect(submitBrowserContext(h.deps, "browser-a", other)).rejects.toMatchObject({
      code: "submission_payload_mismatch",
    })
    expect(h.rows.get("sub-1")).toMatchObject({
      sourceHost: "example.com",
      status: "failed",
    })
    expect(h.createdSessions).toHaveLength(1)
  })

  it("refuses a redrive of a different page on the same host", async () => {
    // The narrow case host + title + mode + byte count cannot separate: one
    // host, two paths, and a payload sized to match. Only the URL tells them
    // apart, which is what `urlFingerprint` is for.
    const h = harness({
      enqueueMessage: async () => {
        throw new Error("HostState unavailable")
      },
    })
    await expect(submitBrowserContext(h.deps, "browser-a", payload())).rejects.toThrow(
      "HostState unavailable"
    )
    const first = h.rows.get("sub-1")
    expect(first).toMatchObject({ sourceHost: "example.com", status: "failed" })
    expect(first?.urlFingerprint).toEqual(expect.any(String))

    const samePayload = payload()
    const sameHostOtherPage = payload({
      context: {
        ...(samePayload as { context: Record<string, unknown> }).context,
        url: "https://example.com/a-different-page",
      },
    })
    await expect(
      submitBrowserContext(h.deps, "browser-a", sameHostOtherPage)
    ).rejects.toMatchObject({
      code: "submission_payload_mismatch",
    })
    expect(h.createdSessions).toHaveLength(1)
  })

  it("still redrives a row written before urlFingerprint existed", async () => {
    // Refusing every retry of an older row would break the recovery path this
    // branch exists for, over a collision no wider than the one that shipped.
    const h = harness({
      enqueueMessage: async () => {
        throw new Error("HostState unavailable")
      },
    })
    await expect(submitBrowserContext(h.deps, "browser-a", payload())).rejects.toThrow(
      "HostState unavailable"
    )
    const legacy = h.rows.get("sub-1")!
    delete (legacy as { urlFingerprint?: string }).urlFingerprint

    h.deps.enqueueMessage = async () => {}
    await expect(submitBrowserContext(h.deps, "browser-a", payload())).resolves.toMatchObject({
      status: "queued",
    })
    expect(h.createdSessions).toHaveLength(1)
  })

  it("refuses to replay another device's submission id", async () => {
    const h = harness()
    await submitBrowserContext(h.deps, "browser-a", payload())
    await expect(submitBrowserContext(h.deps, "browser-b", payload())).rejects.toMatchObject({
      code: "submission_owned_elsewhere",
    })
  })

  it("refuses a workspace the Host did not offer", async () => {
    // The panel's dropdown is populated from this same list, so a mismatch is
    // stale state — not a licence to land a task in an unchosen project.
    const h = harness()
    await expect(
      submitBrowserContext(h.deps, "browser-a", payload({ workspaceId: "ws-not-mine" }))
    ).rejects.toMatchObject({ code: "unknown_workspace" })
    expect(h.createdSessions).toHaveLength(0)
  })

  it("refuses an unbound caller before touching anything", async () => {
    const h = harness()
    await expect(submitBrowserContext(h.deps, "", payload())).rejects.toBeInstanceOf(
      BrowserCompanionError
    )
    expect(h.createdSessions).toHaveLength(0)
  })

  it("turns a validation rejection into a code the panel can act on", async () => {
    const h = harness()
    await expect(
      submitBrowserContext(h.deps, "browser-a", payload({ instruction: "" }))
    ).rejects.toMatchObject({ code: "malformed" })
    await expect(
      submitBrowserContext(h.deps, "browser-a", payload({ instruction: "x".repeat(9_000) }))
    ).rejects.toMatchObject({ code: "payload_too_large" })
    await expect(
      submitBrowserContext(
        h.deps,
        "browser-a",
        payload({ context: { ...payload().context, selection: undefined } })
      )
    ).rejects.toMatchObject({ code: "capture_mode_mismatch" })
  })

  it("records the row before starting the turn", async () => {
    // A crash between the two must leave a recorded submission whose turn
    // HostState redrives, never a running turn the panel cannot show.
    const order: string[] = []
    const h = harness({
      recordSubmission: async () => {
        order.push("record")
      },
      enqueueMessage: async () => {
        order.push("enqueue")
      },
    })
    await submitBrowserContext(h.deps, "browser-a", payload())
    expect(order).toEqual(["record", "enqueue", "record"])
  })

  it("stores only the hostname and the byte count, never the page text", async () => {
    const h = harness()
    await submitBrowserContext(h.deps, "browser-a", payload())
    const row = h.rows.get("sub-1")
    expect(row).toMatchObject({ sourceHost: "example.com", captureMode: "selection" })
    expect(row?.contentBytes).toBe("Team plan is $20".length)
    expect(JSON.stringify(row)).not.toContain("Team plan is $20")
    expect(JSON.stringify(row)).not.toContain("/pricing")
  })

  it("marks the row truncated when anything was cut", async () => {
    const h = harness()
    await submitBrowserContext(
      h.deps,
      "browser-a",
      payload({
        context: { ...payload().context, selection: { text: "clipped", truncated: true } },
      })
    )
    expect(h.rows.get("sub-1")?.truncated).toBe(true)
  })
})

describe("listBrowserContextSubmissions", () => {
  it("returns only this device's submissions, with live status", async () => {
    const h = harness()
    await submitBrowserContext(h.deps, "browser-a", payload())
    await submitBrowserContext(h.deps, "browser-b", payload({ submissionId: "sub-2" }))
    h.statuses.set("session-1", "completed")

    const page = await listBrowserContextSubmissions(h.deps, "browser-a")
    expect(page.items.map((item) => item.submissionId)).toEqual(["sub-1"])
    expect(page.items[0].status).toBe("completed")
    expect(page.items[0].deepLink).toBe(browserSubmissionDeepLink("session-1"))
  })

  it("clamps the limit rather than trusting it", async () => {
    const seen: number[] = []
    const h = harness({
      listSubmissions: async (_deviceId, limit) => {
        seen.push(limit)
        return []
      },
    })
    await listBrowserContextSubmissions(h.deps, "browser-a", { limit: 5_000 })
    await listBrowserContextSubmissions(h.deps, "browser-a", { limit: 0 })
    await listBrowserContextSubmissions(h.deps, "browser-a")
    expect(seen).toEqual([50, 1, 20])
  })

  it("falls back to the recorded status when the runtime cannot be read", async () => {
    // A temporarily unreachable runtime must not rewrite history as failed.
    const h = harness()
    await submitBrowserContext(h.deps, "browser-a", payload())
    h.sessionStatusThrows = true
    const page = await listBrowserContextSubmissions(h.deps, "browser-a")
    expect(page.items[0].status).toBe("queued")
  })

  it("does not let a session with no run overwrite a recorded refusal", async () => {
    // The failure mode this replaced: the reader answered `queued` for "no run
    // found", which is exactly what a refused enqueue leaves behind — so every
    // recorded failure was painted green again on the very next poll.
    const h = harness({
      enqueueMessage: async () => {
        throw new BrowserCompanionError("runtime_target_unavailable", "no runtime")
      },
      sessionStatus: async () => null,
    })
    await submitBrowserContext(h.deps, "browser-a", payload())
    const page = await listBrowserContextSubmissions(h.deps, "browser-a")
    expect(page.items[0].status).toBe("host_unavailable")
  })
})

describe("getBrowserContextSubmission", () => {
  it("reads one submission back", async () => {
    const h = harness()
    await submitBrowserContext(h.deps, "browser-a", payload())
    h.statuses.set("session-1", "needs_input")
    await expect(
      getBrowserContextSubmission(h.deps, "browser-a", { submissionId: "sub-1" })
    ).resolves.toMatchObject({ status: "needs_input", sessionId: "session-1" })
  })

  it("gives the same answer for missing and someone else's", async () => {
    // Distinguishing them would let one browser probe another's ids.
    const h = harness()
    await submitBrowserContext(h.deps, "browser-a", payload())
    const missing = getBrowserContextSubmission(h.deps, "browser-b", { submissionId: "nope" })
    const theirs = getBrowserContextSubmission(h.deps, "browser-b", { submissionId: "sub-1" })
    await expect(missing).rejects.toMatchObject({ code: "submission_not_found" })
    await expect(theirs).rejects.toMatchObject({ code: "submission_not_found" })
  })

  it("requires a submission id", async () => {
    const h = harness()
    await expect(
      getBrowserContextSubmission(h.deps, "browser-a", { submissionId: 7 })
    ).rejects.toMatchObject({ code: "malformed" })
  })
})

describe("getBrowserContextResult", () => {
  it("carries the answer alongside the status, not instead of it", async () => {
    // A result IS a status with the answer attached: a running task has one and
    // not the other, and two shapes would make the panel ask twice for one row.
    const h = harness()
    await submitBrowserContext(h.deps, "browser-a", payload())
    h.answers.set("session-1", { text: "The team plan is $20.", at: 5_000 })
    h.statuses.set("session-1", "completed")

    await expect(
      getBrowserContextResult(h.deps, "browser-a", { submissionId: "sub-1" })
    ).resolves.toMatchObject({
      status: "completed",
      sessionId: "session-1",
      text: "The team plan is $20.",
      truncated: false,
      answeredAt: 5_000,
    })
  })

  it("omits the answer while there is none, rather than sending an empty one", async () => {
    const h = harness()
    await submitBrowserContext(h.deps, "browser-a", payload())
    const result = await getBrowserContextResult(h.deps, "browser-a", { submissionId: "sub-1" })
    expect(result).not.toHaveProperty("text")
  })

  it("cuts a long answer on a character boundary and says it did", async () => {
    // Bytes, not characters: a CJK answer reaches the ceiling at roughly a
    // third of the character count, so a character cap means something
    // different per language.
    const h = harness()
    await submitBrowserContext(h.deps, "browser-a", payload())
    h.answers.set("session-1", { text: "汉".repeat(20_000), at: 1 })
    const result = await getBrowserContextResult(h.deps, "browser-a", { submissionId: "sub-1" })
    expect(result.truncated).toBe(true)
    expect(result.text).not.toContain("\ufffd")
    expect(Buffer.byteLength(result.text ?? "", "utf8")).toBeLessThanOrEqual(32 * 1024)
  })

  it("never cuts an astral codepoint in half", async () => {
    // The old clipper stepped by UTF-16 CODE UNITS while promising it stepped
    // by characters, so a ceiling landing inside an emoji left an unpaired high
    // surrogate — which every UTF-8 encoder renders as U+FFFD. Emoji are four
    // bytes each, so sweeping the ceiling walks the cut across every offset of
    // a pair.
    const h = harness()
    await submitBrowserContext(h.deps, "browser-a", payload())
    h.answers.set("session-1", { text: "😀".repeat(9_000), at: 1 })
    const result = await getBrowserContextResult(h.deps, "browser-a", { submissionId: "sub-1" })
    expect(result.truncated).toBe(true)
    expect(result.text).not.toContain("\ufffd")
    // A lone surrogate at either end is the defect itself, and it survives a
    // `toContain` check because the replacement only appears once encoded.
    expect(/[\ud800-\udbff]$/.test(result.text ?? "")).toBe(false)
    expect(/^[\udc00-\udfff]/.test(result.text ?? "")).toBe(false)
    expect(Buffer.byteLength(result.text ?? "", "utf8")).toBeLessThanOrEqual(32 * 1024)
    // Whole emoji only.
    expect([...(result.text ?? "")].every((char) => char === "😀")).toBe(true)
  })

  it("answers another device's submission exactly as a missing one", async () => {
    const h = harness()
    await submitBrowserContext(h.deps, "browser-a", payload())
    await expect(
      getBrowserContextResult(h.deps, "browser-b", { submissionId: "sub-1" })
    ).rejects.toMatchObject({ code: "submission_not_found" })
  })
})

describe("cancelBrowserContext", () => {
  it("stops the task and reads the status back", async () => {
    const h = harness()
    await submitBrowserContext(h.deps, "browser-a", payload())
    h.statuses.set("session-1", "cancelled")
    await expect(
      cancelBrowserContext(h.deps, "browser-a", { submissionId: "sub-1" })
    ).resolves.toMatchObject({ status: "cancelled" })
    expect(h.aborted).toEqual(["session-1"])
  })

  it("names a refusal by another driver rather than calling it a failure", async () => {
    // `turn.abort` needs live control, so the Host refuses while a desktop
    // holds the attach lease. The run is fine and somebody else is driving it,
    // which is a different thing to tell a person than "this broke".
    const h = harness()
    await submitBrowserContext(h.deps, "browser-a", payload())
    h.abortRefused = true
    await expect(
      cancelBrowserContext(h.deps, "browser-a", { submissionId: "sub-1" })
    ).rejects.toMatchObject({ code: "session_driven_elsewhere" })
  })

  it("does not call every refusal a second driver", async () => {
    // A stale `hostGeneration` comes back as `conflicted`, and a run that will
    // not take an abort comes back with its own rejection code. Neither is
    // fixed by walking to another machine, so neither may borrow the sentence
    // that tells somebody to.
    const h = harness()
    await submitBrowserContext(h.deps, "browser-a", payload())
    h.abortRefused = true
    h.abortRefusalCode = "conflicted"
    await expect(
      cancelBrowserContext(h.deps, "browser-a", { submissionId: "sub-1" })
    ).rejects.toMatchObject({ code: "abort_refused" })
  })

  it("will not stop a task belonging to another device", async () => {
    const h = harness()
    await submitBrowserContext(h.deps, "browser-a", payload())
    await expect(
      cancelBrowserContext(h.deps, "browser-b", { submissionId: "sub-1" })
    ).rejects.toMatchObject({ code: "submission_not_found" })
    expect(h.aborted).toEqual([])
  })
})

const TEMPLATE: ChatTemplateRow = {
  id: "tpl-1",
  name: "Summarize",
  body: "Summarize this in {{tone}}.",
  params: [{ id: "tone", label: "Tone", required: true, kind: "string" }],
  revision: 1,
  usageCount: 0,
  createdAt: 1,
  updatedAt: 1,
}

describe("submitting through a template", () => {
  it("sends the rendered template as the instruction", async () => {
    const h = harness({ templates: [TEMPLATE] })
    await submitBrowserContext(
      h.deps,
      "browser-a",
      payload({ targetId: "template:tpl-1", targetParams: { tone: "plain English" } })
    )
    const text = h.enqueued[0].text
    expect(text).toContain("Summarize this in plain English.")
    // One instruction, not two. The caller's own text is replaced rather than
    // appended: a saved prompt already says what to do with the page.
    expect(text).not.toContain("Summarise the pricing")
  })

  it("names the value it is missing rather than refusing blankly", async () => {
    const h = harness({ templates: [TEMPLATE] })
    await expect(
      submitBrowserContext(h.deps, "browser-a", payload({ targetId: "template:tpl-1" }))
    ).rejects.toMatchObject({ code: "target_params_missing" })
    expect(h.createdSessions).toHaveLength(0)
  })

  it("refuses a template that is no longer offered", async () => {
    const h = harness({ templates: [] })
    await expect(
      submitBrowserContext(h.deps, "browser-a", payload({ targetId: "template:tpl-1" }))
    ).rejects.toMatchObject({ code: "unknown_target" })
  })

  it("reproduces the same prompt on a redrive", async () => {
    // The reason the template is rendered before the replay branch rather than
    // inside the fresh one: a retry that re-rendered differently — or not at
    // all — would put a different message into the transcript the first attempt
    // was aiming at.
    let fail = true
    const texts: string[] = []
    const h = harness({
      templates: [TEMPLATE],
      enqueueMessage: async ({ text }) => {
        texts.push(text)
        if (fail) throw new Error("HostState unavailable")
      },
    })
    const body = payload({ targetId: "template:tpl-1", targetParams: { tone: "plain English" } })
    await expect(submitBrowserContext(h.deps, "browser-a", body)).rejects.toThrow(
      "HostState unavailable"
    )
    fail = false
    await expect(submitBrowserContext(h.deps, "browser-a", body)).resolves.toMatchObject({
      status: "queued",
    })
    expect(texts).toHaveLength(2)
    expect(texts[0]).toBe(texts[1])
    expect(h.createdSessions).toHaveLength(1)
  })

  it("replays an accepted submission whose template has since been deleted", async () => {
    // The ordinary lost-response retry. Resolving the target before the ledger
    // check refused it as `unknown_target` — reporting a failure for work that
    // had already run, which is exactly what the idempotency key exists to
    // prevent. Nothing in a settled replay needs the target.
    const h = harness({ templates: [TEMPLATE] })
    const body = payload({ targetId: "template:tpl-1", targetParams: { tone: "plain English" } })
    const first = await submitBrowserContext(h.deps, "browser-a", body)
    h.templates.length = 0
    await expect(submitBrowserContext(h.deps, "browser-a", body)).resolves.toMatchObject({
      submissionId: first.submissionId,
      status: first.status,
    })
    expect(h.createdSessions).toHaveLength(1)
  })

  it("does not re-record a template use on a settled replay", async () => {
    // `renderTemplate` records the use on the way out, so re-rendering on every
    // duplicate submit bumped the count and rewrote `lastParams` for a request
    // that produced nothing.
    const h = harness({ templates: [TEMPLATE] })
    const body = payload({ targetId: "template:tpl-1", targetParams: { tone: "plain English" } })
    await submitBrowserContext(h.deps, "browser-a", body)
    const rendersAfterFirst = h.renderedTemplates.length
    await submitBrowserContext(h.deps, "browser-a", body)
    expect(h.renderedTemplates).toHaveLength(rendersAfterFirst)
  })
})

describe("filing and dispatching instead of chatting", () => {
  const BOARDS = [{ id: "board-1", name: "Inbox", workspaceId: "ws-default" }]
  const AGENTS = [{ id: "char-1", name: "Researcher" }]

  it("files an issue and starts no conversation", async () => {
    const h = harness({ boards: BOARDS })
    const response = await submitBrowserContext(
      h.deps,
      "browser-a",
      payload({ targetId: "issue:board-1" })
    )

    expect(h.createdSessions).toHaveLength(0)
    expect(h.enqueued).toHaveLength(0)
    expect(h.filedIssues).toHaveLength(1)
    // No `sessionId`, and a link that points where the work actually is.
    expect(response.sessionId).toBeUndefined()
    expect(response.workKind).toBe("issue")
    expect(response.deepLink).toBe("cognia://issues/issue-1")
  })

  it("carries the page's address into the issue but only its host into provenance", async () => {
    const h = harness({ boards: BOARDS })
    await submitBrowserContext(h.deps, "browser-a", payload({ targetId: "issue:board-1" }))
    expect(h.filedIssues[0]).toMatchObject({
      issueProjectId: "board-1",
      workspaceId: "ws-default",
      sourceHost: "example.com",
      url: "https://example.com/pricing",
    })
  })

  it("hands a page to an agent as a task", async () => {
    const h = harness({ agents: AGENTS })
    const response = await submitBrowserContext(
      h.deps,
      "browser-a",
      payload({ targetId: "agent-task:char-1" })
    )
    expect(h.startedTasks[0]).toMatchObject({ agentId: "char-1", workspaceId: "ws-default" })
    expect(response.workKind).toBe("agent-task")
    expect(h.createdSessions).toHaveLength(0)
  })

  it("reads a filed issue's status from its own plane", async () => {
    const h = harness({ boards: BOARDS })
    await submitBrowserContext(h.deps, "browser-a", payload({ targetId: "issue:board-1" }))
    h.workStatuses.set("issue-1", "completed")
    const page = await listBrowserContextSubmissions(h.deps, "browser-a")
    expect(page.items[0]).toMatchObject({ status: "completed", workKind: "issue" })
  })

  it("keeps the recorded status when that plane cannot be read", async () => {
    // Same rule as a session: a reader that has nothing to say must not rewrite
    // history as a failure.
    const h = harness({ boards: BOARDS })
    await submitBrowserContext(h.deps, "browser-a", payload({ targetId: "issue:board-1" }))
    const page = await listBrowserContextSubmissions(h.deps, "browser-a")
    expect(page.items[0].status).toBe("queued")
  })

  it("has no answer to read and nothing to stop", async () => {
    // A card on a board has no transcript and no turn. Both reads say so
    // rather than reaching for a session id that is not there.
    const h = harness({ boards: BOARDS })
    await submitBrowserContext(h.deps, "browser-a", payload({ targetId: "issue:board-1" }))
    await expect(
      getBrowserContextResult(h.deps, "browser-a", { submissionId: "sub-1" })
    ).resolves.not.toHaveProperty("text")
    await expect(
      cancelBrowserContext(h.deps, "browser-a", { submissionId: "sub-1" })
    ).rejects.toMatchObject({ code: "nothing_to_stop" })
  })
})
