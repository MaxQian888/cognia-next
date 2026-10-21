import {
  isMaintenanceTask,
  isSilentMaintenanceType,
  maintenanceNotificationPatch,
  allowsMaintenanceAttention,
  isRetiredMaintenanceTask,
} from "./maintenance-tasks"
import type { ScheduledTask } from "@/types/scheduler"

const task = (type: string, tags?: string[]) =>
  ({ type, ...(tags ? { tags } : {}) }) as Pick<ScheduledTask, "type" | "tags">

describe("isMaintenanceTask", () => {
  it.each([
    "provider-diagnostics-refresh",
    "conversation-auto-archive",
    "github-issue-sync",
    "files-trash-purge",
    "harness-evolution-sweep",
    "connection:presence:refresh",
    "connection:housekeeping:clock",
    "connection:housekeeping:outbound-retention",
    "connection:housekeeping:attachment-cache",
  ])("classifies %s as maintenance", (type) => {
    expect(isMaintenanceTask(task(type))).toBe(true)
  })

  it("classifies any system-tagged task as maintenance", () => {
    expect(isMaintenanceTask(task("bot", ["system:bot-trigger"]))).toBe(true)
    expect(isMaintenanceTask(task("custom", ["user", "system:connector-housekeeping"]))).toBe(true)
  })

  it.each([
    ["connection:scheduled:digest"],
    ["connection:outbound:send"],
    ["plugin"],
    ["agent-task"],
    ["workflow"],
  ])("keeps user-meaningful %s visible", (type) => {
    expect(isMaintenanceTask(task(type, ["plugin:demo", "loop"]))).toBe(false)
  })

  it("treats a missing task as not maintenance", () => {
    expect(isMaintenanceTask(undefined)).toBe(false)
    expect(isMaintenanceTask(null)).toBe(false)
  })
})

it("does not silence a user-authored bot deliverable just because it has a system tag", () => {
  expect(isSilentMaintenanceType("bot")).toBe(false)
  expect(isSilentMaintenanceType("connection:scheduled:digest")).toBe(false)
})

it("keeps ambient maintenance attention opt-in and retains user deliverables", () => {
  const silent = {
    type: "provider-diagnostics-refresh",
    notification: {
      onStart: false,
      onComplete: false,
      onError: false,
      channels: ["none"] as const,
    },
  }
  expect(allowsMaintenanceAttention(silent as never)).toBe(false)
  expect(allowsMaintenanceAttention({ ...silent, type: "bot" } as never)).toBe(true)
  expect(
    allowsMaintenanceAttention({
      ...silent,
      notification: { ...silent.notification, onError: true, channels: ["desktop"] },
    } as never)
  ).toBe(true)
  expect(isRetiredMaintenanceTask({ tags: ["system:maintenance-duplicate"] })).toBe(true)
})

it("mutes the inherited toast defaults including errors and due reminders", () => {
  const explicitToast = {
    dueReminder: false,
    onStart: false,
    onProgress: false,
    onComplete: true,
    onError: true,
    channels: ["toast"] as const,
  }
  expect(maintenanceNotificationPatch(explicitToast as never)).toBeUndefined()
  expect(
    allowsMaintenanceAttention({
      type: "provider-diagnostics-refresh",
      notification: explicitToast,
    } as never)
  ).toBe(true)
  expect(
    maintenanceNotificationPatch({
      onStart: false,
      onComplete: true,
      onError: true,
      channels: ["toast"],
    })
  ).toMatchObject({ channels: ["none"], onError: false, dueReminder: false })
  expect(
    maintenanceNotificationPatch({
      onStart: false,
      onComplete: false,
      onError: true,
      dueReminder: true,
      channels: ["im"],
    })
  ).toBeUndefined()
})
