import type { BrowserSubmissionRow } from "@/lib/db/browser-submissions-types"

import {
  STATUS_WATCH_WINDOW_MS,
  changedDevices,
  readDeviceStatusDigests,
  startBrowserStatusNotifier,
  type DeviceStatusDigests,
} from "./status-notifier"

const NOW = 1_700_000_000_000

function row(overrides: Partial<BrowserSubmissionRow>): BrowserSubmissionRow {
  return {
    submissionId: "sub-1",
    deviceId: "browser-a",
    sessionId: "session-1",
    title: "T",
    sourceHost: "example.com",
    captureMode: "metadata",
    contentBytes: 0,
    truncated: false,
    status: "queued",
    submittedAt: NOW - 1_000,
    updatedAt: NOW - 1_000,
    ...overrides,
  }
}

describe("readDeviceStatusDigests", () => {
  it("digests each device's recent submissions with their live run state", async () => {
    const digests = await readDeviceStatusDigests(
      {
        listSubmissions: async () => [
          row({}),
          row({ submissionId: "sub-2", deviceId: "browser-b", sessionId: undefined }),
          row({
            submissionId: "old",
            submittedAt: NOW - STATUS_WATCH_WINDOW_MS - 1,
            updatedAt: NOW - STATUS_WATCH_WINDOW_MS - 1,
          }),
        ],
        latestRunStatuses: async (ids) => new Map(ids.map((id) => [id, "running"])),
      },
      NOW
    )
    expect(digests).toEqual(
      new Map([
        ["browser-a", "sub-1:queued:running"],
        ["browser-b", "sub-2:queued:-"],
      ])
    )
  })
})

describe("changedDevices", () => {
  it("names devices whose digest appeared, moved or disappeared", () => {
    const before: DeviceStatusDigests = new Map([
      ["a", "1"],
      ["b", "1"],
      ["c", "1"],
    ])
    const after: DeviceStatusDigests = new Map([
      ["a", "1"],
      ["b", "2"],
      ["d", "1"],
    ])
    expect(changedDevices(before, after)).toEqual(["b", "c", "d"])
  })
})

describe("startBrowserStatusNotifier", () => {
  it("treats the first observation as a baseline and hints only changed devices", async () => {
    const notified: string[] = []
    let emit: (digests: DeviceStatusDigests) => void = () => undefined
    const stop = startBrowserStatusNotifier({
      observe: (_read, onResult) => {
        emit = onResult
        return () => undefined
      },
      listSubmissions: async () => [],
      latestRunStatuses: async () => new Map(),
      notify: async (deviceId) => {
        notified.push(deviceId)
      },
    })
    emit(new Map([["browser-a", "x"]]))
    expect(notified).toEqual([])
    emit(
      new Map([
        ["browser-a", "y"],
        ["browser-b", "x"],
      ])
    )
    expect(notified).toEqual(["browser-a", "browser-b"])
    stop()
  })

  it("drops a failed hint instead of throwing", async () => {
    let emit: (digests: DeviceStatusDigests) => void = () => undefined
    startBrowserStatusNotifier({
      observe: (_read, onResult) => {
        emit = onResult
        return () => undefined
      },
      listSubmissions: async () => [],
      latestRunStatuses: async () => new Map(),
      notify: async () => {
        throw new Error("offline")
      },
    })
    emit(new Map())
    expect(() => emit(new Map([["browser-a", "x"]]))).not.toThrow()
  })
})
