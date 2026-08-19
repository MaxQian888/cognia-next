/** @jest-environment jsdom */

import type { BehaviorEventEnvelope } from "@/lib/telemetry/events/track-event"
import { buildPostHogProductExporters, sanitizePostHogCapturedEvent } from "./posthog-product"

const EVENT: BehaviorEventEnvelope = {
  name: "chat.message.sent",
  category: "chat",
  at: 1_777_777_777_000,
  attributes: { sessionId: "session-1", provider: "anthropic", surface: "chat" },
}

it("creates independent managed and BYO exporters and captures with the installation id", async () => {
  const captures: Array<{ instance: string; event: string; properties: Record<string, unknown> }> =
    []
  const init = jest.fn((_: string, config: Record<string, unknown>, name: string) => ({
    capture: (event: string, properties: Record<string, unknown>) => {
      captures.push({ instance: name, event, properties })
    },
    opt_out_capturing: jest.fn(),
    config,
  }))
  const exporters = buildPostHogProductExporters({
    installationId: "installation-1",
    appVersion: "1.2.3",
    runtime: "tauri",
    managed: {
      enabled: true,
      host: "https://us.i.posthog.com",
      projectToken: "phc_managed",
    },
    byo: {
      enabled: true,
      host: "https://eu.i.posthog.com",
      projectToken: "phc_byo",
    },
    loadPostHog: async () => ({ init }),
  })

  expect(exporters.map((exporter) => exporter.id)).toEqual(["posthog-managed", "posthog-byo"])
  await Promise.all(exporters.map((exporter) => exporter.export(EVENT)))
  expect(init).toHaveBeenCalledTimes(2)
  expect(captures).toEqual([
    expect.objectContaining({ instance: "cognia_managed", event: "chat.message.sent" }),
    expect.objectContaining({ instance: "cognia_byo", event: "chat.message.sent" }),
  ])
  expect(captures[0].properties).toMatchObject({
    "cognia.schema_version": 1,
    "cognia.category": "chat",
    "cognia.runtime": "tauri",
    "cognia.app_version": "1.2.3",
    "cognia.sessionId": "session-1",
    $process_person_profile: false,
    $ip: null,
  })
})

it("keeps transport properties but strips browser, content, and exception fields", () => {
  expect(
    sanitizePostHogCapturedEvent({
      event: "chat.message.sent",
      properties: {
        token: "phc_public",
        distinct_id: "installation-1",
        $insert_id: "insert-1",
        $current_url: "https://private.example/path",
        $referrer: "https://private.example",
        "cognia.category": "chat",
        "cognia.prompt": "secret prompt",
        "exception.message": "secret failure",
      },
    })
  ).toEqual({
    event: "chat.message.sent",
    properties: {
      token: "phc_public",
      distinct_id: "installation-1",
      $insert_id: "insert-1",
      "cognia.category": "chat",
    },
  })
})

it("does not create exporters for disabled or malformed destinations", () => {
  expect(
    buildPostHogProductExporters({
      installationId: "installation-1",
      appVersion: "1.2.3",
      runtime: "browser",
      managed: { enabled: true, host: "file:///tmp/posthog", projectToken: "phc_bad" },
      byo: { enabled: false, host: "https://us.i.posthog.com", projectToken: "phc_byo" },
    })
  ).toEqual([])
})

it("opts out and discards a pending SDK batch when the destination is closed", async () => {
  const queued = [{ event: "chat.message.sent" }]
  const clearFlushTimeout = jest.fn()
  const optOut = jest.fn()
  const exporters = buildPostHogProductExporters({
    installationId: "installation-1",
    appVersion: "1.2.3",
    runtime: "browser",
    managed: {
      enabled: true,
      host: "https://us.i.posthog.com",
      projectToken: "phc_managed",
    },
    byo: { enabled: false, host: "", projectToken: "" },
    loadPostHog: async () => ({
      init: () => ({
        capture: jest.fn(),
        opt_out_capturing: optOut,
        _requestQueue: { _queue: queued, _clearFlushTimeout: clearFlushTimeout },
      }),
    }),
  })
  await exporters[0].export(EVENT)
  await exporters[0].close?.()
  expect(optOut).toHaveBeenCalled()
  expect(clearFlushTimeout).toHaveBeenCalled()
  expect(queued).toEqual([])
})
