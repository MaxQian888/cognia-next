import { describe, expect, it } from "vitest"

import { renderError, renderRead, renderWriteResult } from "./format"

describe("format", () => {
  it("renders incident detail with corrections and ownership", () => {
    const lines = renderRead("incident", {
      incident: {
        id: "inc_1",
        revision: 3,
        state: "monitoring",
        impact: "major_outage",
        componentIds: ["relayData"],
        source: "automated",
        startedAt: "2026-10-02T10:00:00.000Z",
        title: { en: "Relay down" },
        pinned: true,
        manualOwner: "op@example.com",
        predecessorId: "inc_0",
        updates: [
          {
            id: "upd_1",
            at: "2026-10-02T10:00:00.000Z",
            state: "investigating",
            source: "automated",
            message: { en: "Failing" },
            correctionOf: null,
          },
          {
            id: "upd_2",
            at: "2026-10-02T10:05:00.000Z",
            state: "investigating",
            source: "manual",
            message: { en: "Failing checks" },
            correctionOf: "upd_1",
          },
        ],
      },
    })
    expect(lines[0]).toContain("[pinned]")
    expect(lines).toContain("owner: op@example.com")
    expect(lines).toContain("follows: inc_0")
    expect(lines[4]).toContain("(corrects upd_1): Failing checks")
  })

  it("renders empty lists, deliveries and maintenance", () => {
    expect(renderRead("probes", { probes: [] })).toEqual(["(no probes)"])
    expect(
      renderRead("deliveries", {
        deliveries: [
          {
            id: "out_1",
            state: "uncertain",
            attempts: 1,
            lastErrorCode: "timeout",
            providerMessageId: null,
            eventId: "e",
            updatedAt: "t",
          },
        ],
      })[0]
    ).toBe("out_1  uncertain  attempts 1  error timeout  provider -  event e  updated t")
    expect(
      renderRead("maintenance", {
        maintenance: [
          {
            id: "mnt_1",
            revision: 2,
            state: "completed",
            startsAt: "a",
            endsAt: "b",
            actualEndAt: "c",
            componentIds: ["relayData"],
            excludeFromAvailability: true,
            title: { en: "Up" },
          },
        ],
      })[0]
    ).toBe("mnt_1  rev 2  completed  a → b  actual end c  relayData  excluded  Up")
  })

  it("summarises writes and errors without leaking unknown structures", () => {
    expect(
      renderWriteResult({ registryRevision: 4, probeId: "ext-1", probe: { nested: true } })
    ).toEqual(["registryRevision=4  probeId=ext-1"])
    expect(renderError(503, { code: "unavailable", requestId: "r" })).toEqual([
      "Error 503: unavailable",
      "requestId: r",
    ])
    expect(renderError(409, { code: "conflict", reason: "probe_exists" })[0]).toBe(
      "Error 409: conflict (probe_exists)"
    )
  })
})
