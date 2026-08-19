/** @jest-environment jsdom */

import type { BehaviorEventEnvelope } from "@/lib/telemetry/events/track-event"
import type { PostHogPostJson } from "./posthog-product"
import {
  buildPostHogEventProperties,
  buildPostHogProductExporters,
  postHogCaptureEndpoint,
  resetPostHogProductExporters,
} from "./posthog-product"

const EVENT: BehaviorEventEnvelope = {
  name: "chat.message.sent",
  category: "chat",
  at: 1_777_777_777_000,
  attributes: { sessionId: "session-1", provider: "anthropic", surface: "chat" },
}

interface CaptureBatchBody {
  api_key: string
  sent_at: string
  batch: Array<{
    event: string
    distinct_id: string
    timestamp: string
    uuid: string
    properties: Record<string, unknown>
  }>
}

const noopPostJson: jest.MockedFunction<PostHogPostJson> = jest.fn<Promise<void>, [string, string]>(
  async () => {}
)

const BASE = {
  installationId: "installation-1",
  appVersion: "1.2.3",
  runtime: "tauri",
  flushIntervalMs: 0,
} as const

beforeEach(() => {
  resetPostHogProductExporters()
})

afterEach(() => {
  resetPostHogProductExporters()
})

it("posts each destination's batch to the PostHog capture API", async () => {
  const posts: Array<{ url: string; body: CaptureBatchBody }> = []
  const postJson: PostHogPostJson = async (url, body) => {
    posts.push({ url, body: JSON.parse(body) as CaptureBatchBody })
  }
  const exporters = buildPostHogProductExporters({
    ...BASE,
    managed: { enabled: true, host: "https://us.i.posthog.com", projectToken: "phc_managed" },
    byo: { enabled: true, host: "https://eu.i.posthog.com/", projectToken: " phc_byo " },
    postJson,
  })

  expect(exporters.map((exporter) => exporter.id)).toEqual(["posthog-managed", "posthog-byo"])
  await Promise.all(exporters.map((exporter) => exporter.export(EVENT)))

  expect(posts.map((post) => post.url)).toEqual([
    "https://us.i.posthog.com/batch/",
    "https://eu.i.posthog.com/batch/",
  ])
  expect(posts[0].body).toMatchObject({
    api_key: "phc_managed",
    batch: [
      {
        event: "chat.message.sent",
        distinct_id: "installation-1",
        timestamp: new Date(EVENT.at).toISOString(),
        properties: expect.objectContaining({
          "cognia.schema_version": 1,
          "cognia.category": "chat",
          "cognia.runtime": "tauri",
          "cognia.app_version": "1.2.3",
          "cognia.sessionId": "session-1",
          $lib: "cognia",
          $process_person_profile: false,
          $geoip_disable: true,
        }),
      },
    ],
  })
  expect(posts[1].body).toMatchObject({ api_key: "phc_byo" })
  expect(typeof posts[0].body.batch[0].uuid).toBe("string")
})

it("buffers until the batch size is reached, then sends one request", async () => {
  const postJson: jest.MockedFunction<PostHogPostJson> = jest.fn<Promise<void>, [string, string]>(
    async () => {}
  )
  const [exporter] = buildPostHogProductExporters({
    ...BASE,
    flushIntervalMs: 60_000,
    batchSize: 3,
    managed: { enabled: true, host: "https://us.i.posthog.com", projectToken: "phc_managed" },
    byo: { enabled: false, host: "", projectToken: "" },
    postJson,
  })

  const pending = [exporter.export(EVENT), exporter.export(EVENT)]
  await Promise.resolve()
  expect(postJson).not.toHaveBeenCalled()

  pending.push(exporter.export(EVENT))
  await Promise.all(pending)
  expect(postJson).toHaveBeenCalledTimes(1)
  const sent = JSON.parse(postJson.mock.calls[0][1]) as CaptureBatchBody
  expect(sent.batch).toHaveLength(3)
})

it("rejects the events in a batch the destination refused", async () => {
  const [exporter] = buildPostHogProductExporters({
    ...BASE,
    managed: { enabled: true, host: "https://us.i.posthog.com", projectToken: "phc_managed" },
    byo: { enabled: false, host: "", projectToken: "" },
    postJson: async () => {
      throw new Error("PostHog capture failed with 401")
    },
  })
  await expect(exporter.export(EVENT)).rejects.toThrow("401")
})

it("keeps the classifier and measure attributes an operator needs", () => {
  expect(
    buildPostHogEventProperties(
      {
        ...EVENT,
        name: "chat.turn.failed",
        attributes: { sessionId: "session-1", errorType: "rate_limit", resultCount: 3 },
      },
      { appVersion: "1.2.3", runtime: "browser" }
    )
  ).toMatchObject({
    "cognia.errorType": "rate_limit",
    "cognia.resultCount": 3,
  })
})

it("strips attributes that could carry user content", () => {
  expect(
    buildPostHogEventProperties(
      {
        ...EVENT,
        attributes: {
          surface: "chat",
          prompt: "secret prompt",
          errorMessage: "secret failure",
          filePath: "/Users/someone/private.txt",
        },
      },
      { appVersion: "1.2.3", runtime: "browser" }
    )
  ).toEqual({
    "cognia.schema_version": 1,
    "cognia.category": "chat",
    "cognia.runtime": "browser",
    "cognia.app_version": "1.2.3",
    "cognia.surface": "chat",
    $lib: "cognia",
    $lib_version: "1.2.3",
    $process_person_profile: false,
    $geoip_disable: true,
  })
})

it("does not create exporters for disabled or malformed destinations", () => {
  expect(
    buildPostHogProductExporters({
      ...BASE,
      runtime: "browser",
      managed: { enabled: true, host: "file:///tmp/posthog", projectToken: "phc_bad" },
      byo: { enabled: false, host: "https://us.i.posthog.com", projectToken: "phc_byo" },
      postJson: noopPostJson,
    })
  ).toEqual([])
})

it("reuses a live exporter across settings re-applies and closes removed ones", async () => {
  const postJson: jest.MockedFunction<PostHogPostJson> = jest.fn<Promise<void>, [string, string]>(
    async () => {}
  )
  const build = (byoEnabled: boolean) =>
    buildPostHogProductExporters({
      ...BASE,
      flushIntervalMs: 60_000,
      managed: { enabled: true, host: "https://us.i.posthog.com", projectToken: "phc_managed" },
      byo: { enabled: byoEnabled, host: "https://eu.i.posthog.com", projectToken: "phc_byo" },
      postJson,
    })

  const first = build(true)
  const byoPending = first[1].export(EVENT)
  const second = build(false)

  expect(second).toHaveLength(1)
  expect(second[0]).toBe(first[0])
  await expect(byoPending).rejects.toThrow("closed")
  expect(postJson).not.toHaveBeenCalled()
})

it("discards the queue when consent is withdrawn", async () => {
  const postJson: jest.MockedFunction<PostHogPostJson> = jest.fn<Promise<void>, [string, string]>(
    async () => {}
  )
  const [exporter] = buildPostHogProductExporters({
    ...BASE,
    flushIntervalMs: 60_000,
    managed: { enabled: true, host: "https://us.i.posthog.com", projectToken: "phc_managed" },
    byo: { enabled: false, host: "", projectToken: "" },
    postJson,
  })
  const pending = exporter.export(EVENT)
  exporter.close?.()
  await expect(pending).rejects.toThrow("closed")
  expect(postJson).not.toHaveBeenCalled()
})

it("normalizes the capture endpoint to the host origin", () => {
  expect(postHogCaptureEndpoint("https://us.i.posthog.com/some/path")).toBe(
    "https://us.i.posthog.com/batch/"
  )
})

it("flushes the buffer when the document goes away", async () => {
  const postJson: jest.MockedFunction<PostHogPostJson> = jest.fn<Promise<void>, [string, string]>(
    async () => {}
  )
  const [exporter] = buildPostHogProductExporters({
    ...BASE,
    flushIntervalMs: 60_000,
    managed: { enabled: true, host: "https://us.i.posthog.com", projectToken: "phc_managed" },
    byo: { enabled: false, host: "", projectToken: "" },
    postJson,
  })
  const pending = exporter.export(EVENT)
  window.dispatchEvent(new Event("pagehide"))
  await pending
  expect(postJson).toHaveBeenCalledTimes(1)
})

it("replaces a closed exporter instead of handing back a dead one", async () => {
  const postJson: jest.MockedFunction<PostHogPostJson> = jest.fn<Promise<void>, [string, string]>(
    async () => {}
  )
  const build = () =>
    buildPostHogProductExporters({
      ...BASE,
      managed: { enabled: true, host: "https://us.i.posthog.com", projectToken: "phc_managed" },
      byo: { enabled: false, host: "", projectToken: "" },
      postJson,
    })

  // A host that tears its destinations down and starts them back up in the
  // same process (the headless brain) must not get the dead instance back.
  const [first] = build()
  first.close?.()
  const [second] = build()
  expect(second).not.toBe(first)
  await expect(second.export(EVENT)).resolves.toBeUndefined()
  expect(postJson).toHaveBeenCalledTimes(1)
})

it("defers to the account-wide remote consent when a host has no per-destination switch", () => {
  const [ownConsent] = buildPostHogProductExporters({
    ...BASE,
    managed: { enabled: true, host: "https://us.i.posthog.com", projectToken: "phc_managed" },
    byo: { enabled: false, host: "", projectToken: "" },
    postJson: noopPostJson,
  })
  expect(ownConsent.requiresRemoteConsent).toBeFalsy()

  const [remoteConsent] = buildPostHogProductExporters({
    ...BASE,
    requiresRemoteConsent: true,
    managed: { enabled: true, host: "https://us.i.posthog.com", projectToken: "phc_managed" },
    byo: { enabled: false, host: "", projectToken: "" },
    postJson: noopPostJson,
  })
  // A different consent model is a different destination, never a reuse.
  expect(remoteConsent).not.toBe(ownConsent)
  expect(remoteConsent.requiresRemoteConsent).toBe(true)
})

it("works where `window` is the bare Node global with no event target", async () => {
  const realAddEventListener = window.addEventListener
  const realRemoveEventListener = window.removeEventListener
  // The headless brain shims `window` onto globalThis, which has no
  // addEventListener — reaching for it unguarded used to throw in the ctor.
  Reflect.deleteProperty(window, "addEventListener")
  Reflect.deleteProperty(window, "removeEventListener")
  try {
    const postJson: jest.MockedFunction<PostHogPostJson> = jest.fn<Promise<void>, [string, string]>(
      async () => {}
    )
    const [exporter] = buildPostHogProductExporters({
      ...BASE,
      runtime: "brain",
      managed: { enabled: true, host: "https://us.i.posthog.com", projectToken: "phc_managed" },
      byo: { enabled: false, host: "", projectToken: "" },
      postJson,
    })
    await expect(exporter.export(EVENT)).resolves.toBeUndefined()
    expect(postJson).toHaveBeenCalledTimes(1)
    expect(() => exporter.close?.()).not.toThrow()
  } finally {
    window.addEventListener = realAddEventListener
    window.removeEventListener = realRemoveEventListener
  }
})
