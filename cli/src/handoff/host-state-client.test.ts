import type { HostStateAppliedActionV1 } from "@cognia/agent-config-types/host-state"

import {
  flushAttachedHostStateOutbox,
  queueAttachedHostStateAction,
  readAttachedHostStateOutbox,
  createLocalHostStateClient,
  type AttachedHostStateRecord,
} from "./host-state-client"

const endpoint = { baseUrl: "http://127.0.0.1:1234", devToken: "secret" }

function writableStatus(hostId = "host-a", hostGeneration = 3) {
  return {
    protocolVersion: 1 as const,
    hostId,
    hostGeneration,
    hostSeq: 7,
    migrationStage: "hoststate-authoritative" as const,
    leaseExpiresAt: 100,
    pendingDispatch: 0,
    pendingBroadcast: 0,
  }
}

describe("local HostState attach client", () => {
  it("reuses loopback dev-token auth for snapshots and events", async () => {
    const event: HostStateAppliedActionV1 = {
      protocolVersion: 1,
      channel: "cognia://target/target-a/sessions/session-a",
      hostId: "host-a",
      hostGeneration: 2,
      hostSeq: 5,
      outcome: "applied",
    }
    const fetcher = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          result: {
            protocolVersion: 1,
            hostId: "host-a",
            hostGeneration: 2,
            hostSeq: 5,
            migrationStage: "shadow",
            leaseExpiresAt: 100,
            pendingDispatch: 0,
            pendingBroadcast: 0,
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, events: [event] }),
      })
    const client = createLocalHostStateClient(endpoint, { fetch: fetcher as typeof fetch })

    await client.status({
      protocolVersion: 1,
      accountId: "local-default",
      runtimeTargetId: "target-a",
    })
    await expect(client.nextEvents(4)).resolves.toEqual([event])

    expect(fetcher.mock.calls[0][1].headers).toMatchObject({ "X-Cognia-Dev-Token": "secret" })
    expect(fetcher.mock.calls[1][0]).toContain("afterHostSeq=4")
  })

  it("fails closed on malformed bridge envelopes", async () => {
    const client = createLocalHostStateClient(endpoint, {
      fetch: jest.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) }) as never,
    })
    await expect(
      client.status({ protocolVersion: 1, accountId: "local-default", runtimeTargetId: "target-a" })
    ).rejects.toThrow("host_state_bridge_malformed")
  })

  it("validates canonical Agent RPC envelopes before attached TUI replay", async () => {
    const envelope = {
      schemaVersion: 1,
      eventId: "event-1",
      sequence: 1,
      sessionId: "session-a",
      runId: "run-1",
      turnId: "turn-1",
      attemptId: "attempt-1",
      hostRef: "host-a",
      runtime: "anthropic-agent-sdk",
      timestamp: "2026-08-14T00:00:00.000Z",
      event: { kind: "text-delta", delta: "hello" },
    }
    const fetcher = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, cursor: 1, events: [envelope] }),
    })
    const client = createLocalHostStateClient(endpoint, { fetch: fetcher as typeof fetch })

    await expect(client.nextAgentEvents()).resolves.toEqual([envelope])
    expect(fetcher.mock.calls[0][0]).toContain("/host-state/agent-events")

    fetcher.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, cursor: 2, events: [{ eventId: "bad" }] }),
    })
    await expect(client.nextAgentEvents()).rejects.toThrow("host_state_agent_events_malformed")
  })

  it("re-snapshots instead of skipping a truncated HostState replay window", async () => {
    const event: HostStateAppliedActionV1 = {
      protocolVersion: 1,
      channel: "cognia://target/target-a/sessions/session-a",
      hostId: "host-a",
      hostGeneration: 2,
      hostSeq: 5,
      outcome: "applied",
    }
    const fetcher = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, events: [], gap: true }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, events: [event], gap: false }),
      })
    const client = createLocalHostStateClient(endpoint, { fetch: fetcher as typeof fetch })
    const controller = new AbortController()
    const onEvent = jest.fn(() => controller.abort())
    const onResync = jest.fn(async () => 4)

    await client.subscribe(1, onEvent, controller.signal, onResync)

    expect(onResync).toHaveBeenCalledTimes(1)
    expect(onEvent).toHaveBeenCalledWith(event)
    expect(fetcher.mock.calls[1][0]).toContain("afterHostSeq=4")
  })

  it("persists attached actions before submission and retains terminal receipts", async () => {
    const files = new Map<string, string>()
    const io = {
      home: "/tmp/cognia-host-state-test",
      readFile: (file: string) => files.get(file) ?? null,
      writeFile: (file: string, value: string) => files.set(file, value),
    }
    const record: AttachedHostStateRecord = {
      protocolVersion: 1,
      accountId: "account-a",
      runtimeTargetId: "target-a",
      hostId: "host-a",
      hostGeneration: 3,
      sessionId: "session-a",
      attachedAt: 1,
    }
    const action = queueAttachedHostStateAction(
      record,
      { kind: "message.enqueue", messageId: "message-a", text: "hello", attachments: [] },
      { ...io, baseRevision: 7, now: () => 10, randomId: () => "action-a" }
    )

    expect(readAttachedHostStateOutbox(io)).toEqual([
      expect.objectContaining({ action, status: "pending" }),
    ])
    const submit = jest.fn().mockResolvedValue({
      protocolVersion: 1,
      results: [
        {
          actionId: action.actionId,
          outcome: "applied",
          hostGeneration: 3,
          hostSeq: 8,
        },
      ],
    })
    await flushAttachedHostStateOutbox(
      {
        record,
        client: { status: jest.fn().mockResolvedValue(writableStatus()), submit } as never,
      },
      io
    )

    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({ actions: [action], runtimeTargetId: "target-a" })
    )
    expect(readAttachedHostStateOutbox(io)).toEqual([
      expect.objectContaining({ status: "sent", receipt: expect.objectContaining({ hostSeq: 8 }) }),
    ])
  })

  it("keeps transient failures pending and never replays another target's rows", async () => {
    const files = new Map<string, string>()
    const io = {
      home: "/tmp/cognia-host-state-isolation-test",
      readFile: (file: string) => files.get(file) ?? null,
      writeFile: (file: string, value: string) => files.set(file, value),
    }
    const record: AttachedHostStateRecord = {
      protocolVersion: 1,
      accountId: "account-a",
      runtimeTargetId: "target-a",
      hostId: "host-a",
      hostGeneration: 3,
      sessionId: "session-a",
      attachedAt: 1,
    }
    queueAttachedHostStateAction(record, { kind: "turn.abort" }, { ...io, randomId: () => "a" })
    const failingSubmit = jest.fn().mockRejectedValue(new Error("offline"))
    await expect(
      flushAttachedHostStateOutbox(
        {
          record,
          client: {
            status: jest.fn().mockResolvedValue(writableStatus()),
            submit: failingSubmit,
          } as never,
        },
        io
      )
    ).rejects.toThrow("offline")
    expect(readAttachedHostStateOutbox(io)[0]).toMatchObject({
      status: "pending",
      lastError: "offline",
    })

    const otherRecord = { ...record, runtimeTargetId: "target-b" }
    const otherSubmit = jest.fn()
    await flushAttachedHostStateOutbox(
      { record: otherRecord, client: { submit: otherSubmit } as never },
      io
    )
    expect(otherSubmit).not.toHaveBeenCalled()
  })

  it("freezes attached actions while the Host is not authoritative", async () => {
    const files = new Map<string, string>()
    const io = {
      home: "/tmp/cognia-host-state-frozen-test",
      readFile: (file: string) => files.get(file) ?? null,
      writeFile: (file: string, value: string) => files.set(file, value),
    }
    const record: AttachedHostStateRecord = {
      protocolVersion: 1,
      accountId: "account-a",
      runtimeTargetId: "target-a",
      hostId: "host-a",
      hostGeneration: 3,
      sessionId: "session-a",
      attachedAt: 1,
    }
    queueAttachedHostStateAction(record, { kind: "turn.abort" }, { ...io, randomId: () => "a" })
    const submit = jest.fn()

    await flushAttachedHostStateOutbox(
      {
        record,
        client: {
          status: jest
            .fn()
            .mockResolvedValue({ ...writableStatus(), migrationStage: "hoststate-read" }),
          submit,
        } as never,
      },
      io
    )

    expect(submit).not.toHaveBeenCalled()
    expect(readAttachedHostStateOutbox(io)).toEqual([
      expect.objectContaining({ status: "pending" }),
    ])
  })
})
