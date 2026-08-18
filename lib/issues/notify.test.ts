/**
 * @jest-environment jsdom
 */

import type { NotificationInput } from "@/types/notifications"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { patchConversationOverride } from "@/lib/db/conversation-overrides"
import { createIssueProject } from "@/lib/db/issue-projects"
import { addIssueComment, createIssue, setIssueAssignee } from "@/lib/db/issues"
import { getDb } from "@/lib/db/schema"
import {
  __resetNotificationCommandsForTesting,
  dispatchNotificationCommand,
  hasNotificationCommand,
} from "@/lib/notifications/action-registry"
import {
  DEFAULT_ISSUE_NOTIFY_TEXT,
  ISSUE_OPEN_COMMAND,
  __resetIssueNotificationsForTesting,
  defaultIssueNotifyTranslate,
  installIssueNotificationCommands,
  installIssueNotifications,
  issueEventToNotification,
  notifyIssueEvent,
  resolveIssueConversationKeys,
} from "./notify"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)
afterEach(() => {
  __resetIssueNotificationsForTesting()
  __resetNotificationCommandsForTesting()
})

const HUMAN = { kind: "human" } as const
const ISSUE = { id: "iss-1", identifier: "MERC-1", title: "Ship it", issueProjectId: "ip-1" }

describe("defaultIssueNotifyTranslate", () => {
  it("interpolates the English fallback and echoes unknown keys", () => {
    expect(
      defaultIssueNotifyTranslate("notify.assigned.title", { identifier: "M-1", to: "Ada" })
    ).toBe("M-1 assigned to Ada")
    expect(defaultIssueNotifyTranslate("nope")).toBe("nope")
    expect(Object.keys(DEFAULT_ISSUE_NOTIFY_TEXT).length).toBeGreaterThan(10)
  })
})

describe("issueEventToNotification", () => {
  it("projects the notifying kinds and returns null for the rest", () => {
    const assigned = issueEventToNotification(ISSUE, {
      kind: "assigned",
      to: { kind: "agent", id: "c", label: "Ada" },
      by: HUMAN,
    })
    expect(assigned).toMatchObject({
      level: "info",
      title: "MERC-1 assigned to Ada",
      body: "Ship it",
      dedupeKey: "issue:iss-1:assigned",
      directed: true,
      href: "/issues?id=iss-1",
      groupKey: "issue:iss-1",
      actions: [
        {
          id: "open",
          command: ISSUE_OPEN_COMMAND,
          args: { issueId: "iss-1" },
          label: "Open issue",
        },
      ],
    })
    expect(
      issueEventToNotification(ISSUE, {
        kind: "reassigned",
        from: HUMAN,
        to: { kind: "team" },
        by: HUMAN,
      })
    ).toMatchObject({ title: "MERC-1 reassigned to a squad" })
    expect(
      issueEventToNotification(ISSUE, { kind: "run_succeeded", runId: "r", adapterId: "a" })
    ).toMatchObject({ level: "success", title: "MERC-1 run finished — ready for review" })
    expect(
      issueEventToNotification(ISSUE, {
        kind: "run_failed",
        runId: "r",
        adapterId: "a",
        error: "boom",
      })
    ).toMatchObject({ level: "error", body: "boom" })
    expect(
      issueEventToNotification(ISSUE, {
        kind: "status_changed",
        from: "todo",
        to: "in_review",
        by: HUMAN,
      })
    ).toMatchObject({ title: "MERC-1 moved to In review", directed: false })
    expect(
      issueEventToNotification(ISSUE, {
        kind: "status_changed",
        from: "todo",
        to: "in_progress",
        by: HUMAN,
      })
    ).toBeNull()
    expect(
      issueEventToNotification(ISSUE, {
        kind: "commented",
        commentId: "c",
        body: "looks wrong",
        by: { kind: "agent", id: "a1" },
      })
    ).toMatchObject({ title: "New comment on MERC-1 from an agent", body: "looks wrong" })
    expect(
      issueEventToNotification(ISSUE, {
        kind: "commented",
        commentId: "c",
        body: "mine",
        by: HUMAN,
      })
    ).toBeNull()
    expect(issueEventToNotification(ISSUE, { kind: "created", by: HUMAN })).toBeNull()
    expect(
      issueEventToNotification(ISSUE, { kind: "label_added", labelId: "l", by: HUMAN })
    ).toBeNull()
  })

  it("uses the injected translator", () => {
    const out = issueEventToNotification(
      ISSUE,
      { kind: "run_failed", runId: "r", adapterId: "a", error: "e" },
      (key, values) => `${key}|${JSON.stringify(values ?? {})}`
    )
    expect(out?.title).toBe(
      'notify.run_failed.title|{"identifier":"MERC-1","title":"Ship it","error":"e"}'
    )
    expect(out?.actions?.[0]?.label).toBe("notify.open|{}")
  })
})

describe("resolveIssueConversationKeys", () => {
  it("collects the IM origin and every conversation bound to the project, deduped", async () => {
    await patchConversationOverride("lark:oc_a", { issueProjectId: "ip-1" }, "s1")
    await patchConversationOverride("lark:oc_b", { issueProjectId: "ip-1" }, "s2")
    await patchConversationOverride("lark:oc_c", { issueProjectId: "ip-other" }, "s3")
    expect(
      await resolveIssueConversationKeys({
        issueProjectId: "ip-1",
        origin: { kind: "im", conversationKey: "lark:oc_b" },
      })
    ).toEqual(["lark:oc_b", "lark:oc_a"])
    expect(await resolveIssueConversationKeys({ issueProjectId: "ip-none" })).toEqual([])
  })
})

describe("notifyIssueEvent", () => {
  it("emits one center record without conversations, one IM-targeted record per conversation", async () => {
    const sent: NotificationInput[] = []
    const notify = async (input: NotificationInput) => {
      sent.push(input)
      return `n${sent.length}`
    }
    const payload = { kind: "run_succeeded" as const, runId: "r", adapterId: "a" }
    expect(
      await notifyIssueEvent(ISSUE, payload, { notify, conversationKeysFor: async () => [] })
    ).toEqual(["n1"])
    expect(sent[0]).toMatchObject({ source: "issue", sourceRef: { kind: "issue", id: "iss-1" } })
    expect(sent[0].channels).toBeUndefined()

    expect(
      await notifyIssueEvent(ISSUE, payload, {
        notify,
        conversationKeysFor: async () => ["lark:a", "lark:b"],
      })
    ).toEqual(["n2", "n3"])
    expect(sent[1]).toMatchObject({
      channels: ["center", "im"],
      sourceRef: { kind: "conversation", id: "lark:a" },
      dedupeKey: "issue:iss-1:run_succeeded:lark:a",
    })
    expect(sent[2].sourceRef).toEqual({ kind: "conversation", id: "lark:b" })

    expect(await notifyIssueEvent(ISSUE, { kind: "created", by: HUMAN }, { notify })).toEqual([])
  })
})

describe("installIssueNotifications", () => {
  const flush = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms))

  it("notifies for events appended after boot, once each, and is idempotent", async () => {
    const project = await createIssueProject({ projectId: "w1", name: "M", key: "MERC" })
    const issue = await createIssue({
      projectId: "w1",
      issueProjectId: project.id,
      title: "t",
      createdBy: HUMAN,
      origin: { kind: "im", conversationKey: "lark:oc_1" },
    })
    // Pre-boot history must not notify.
    await addIssueComment(issue.id, "old", { kind: "agent", id: "a" })
    await flush(5)

    const sent: NotificationInput[] = []
    const notify = async (input: NotificationInput) => {
      sent.push(input)
      return "id"
    }
    const errors: unknown[] = []
    const dispose = installIssueNotifications({ notify, onError: (e) => errors.push(e) })
    expect(installIssueNotifications({ notify })).toBe(dispose)
    await flush()
    expect(sent).toEqual([])

    await setIssueAssignee(issue.id, { kind: "agent", id: "c1", label: "Ada" }, HUMAN)
    await flush()
    expect(sent.map((s) => s.title)).toEqual(["MERC-1 assigned to Ada"])
    expect(sent[0]).toMatchObject({ sourceRef: { kind: "conversation", id: "lark:oc_1" } })

    // A non-notifying event and a second notifying one.
    await addIssueComment(issue.id, "by me", HUMAN)
    await addIssueComment(issue.id, "by agent", { kind: "agent", id: "a" })
    await flush()
    expect(sent.map((s) => s.title)).toEqual([
      "MERC-1 assigned to Ada",
      "New comment on MERC-1 from an agent",
    ])
    expect(errors).toEqual([])
    dispose()
    dispose()

    // After dispose, nothing more.
    await addIssueComment(issue.id, "later", { kind: "agent", id: "a" })
    await flush()
    expect(sent).toHaveLength(2)
  })

  it("skips events whose issue vanished and routes notify failures to onError", async () => {
    const project = await createIssueProject({ projectId: "w1", name: "M", key: "MERC" })
    const issue = await createIssue({
      projectId: "w1",
      issueProjectId: project.id,
      title: "t",
      createdBy: HUMAN,
    })
    const errors: unknown[] = []
    const dispose = installIssueNotifications({
      notify: async () => {
        throw new Error("center down")
      },
      onError: (e) => errors.push(e),
    })
    await getDb().issueEvents.add({
      id: "orphan",
      issueId: "missing",
      kind: "assigned",
      ts: Date.now() + 5,
      payload: { kind: "assigned", to: { kind: "team" }, by: HUMAN },
    })
    await setIssueAssignee(issue.id, { kind: "team", id: "t" }, HUMAN)
    await flush()
    expect(errors.map((e) => (e as Error).message)).toEqual(["center down"])
    dispose()
  })
})

describe("installIssueNotificationCommands", () => {
  it("navigates to the issue for issue.open and ignores malformed args", async () => {
    const navigate = jest.fn()
    const dispose = installIssueNotificationCommands({ navigate })
    expect(hasNotificationCommand(ISSUE_OPEN_COMMAND)).toBe(true)
    await dispatchNotificationCommand({
      notificationId: "n",
      command: ISSUE_OPEN_COMMAND,
      args: { issueId: "iss-9" },
    })
    expect(navigate).toHaveBeenCalledWith("/issues?id=iss-9")
    await dispatchNotificationCommand({
      notificationId: "n",
      command: ISSUE_OPEN_COMMAND,
      args: {},
    })
    await dispatchNotificationCommand({ notificationId: "n", command: ISSUE_OPEN_COMMAND })
    expect(navigate).toHaveBeenCalledTimes(1)
    dispose()
    expect(hasNotificationCommand(ISSUE_OPEN_COMMAND)).toBe(false)
  })
})
