/** @jest-environment jsdom */

import type { BehaviorEventEnvelope } from "@/lib/telemetry/events/track-event"
import type { PostHogPostJson } from "./posthog-product"
import {
  buildPostHogEventProperties,
  buildPostHogProductExporters,
  isValidPostHogProject,
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
  jest.restoreAllMocks()
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

it("falls back to a local event UUID when Web Crypto is unavailable", async () => {
  const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto")
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: undefined })
  jest.spyOn(Date, "now").mockReturnValue(0x123)
  jest.spyOn(Math, "random").mockReturnValue(0.5)
  let body: CaptureBatchBody | undefined
  try {
    const [exporter] = buildPostHogProductExporters({
      ...BASE,
      managed: { enabled: true, host: "https://us.i.posthog.com", projectToken: "phc_managed" },
      byo: { enabled: false, host: "", projectToken: "" },
      postJson: async (_url, serialized) => {
        body = JSON.parse(serialized) as CaptureBatchBody
      },
    })

    await exporter.export(EVENT)

    expect(body?.batch[0].uuid).toBe("123-8")
  } finally {
    if (cryptoDescriptor) Object.defineProperty(globalThis, "crypto", cryptoDescriptor)
    else Reflect.deleteProperty(globalThis, "crypto")
  }
})

it("uses the production fetch contract when no postJson seam is supplied", async () => {
  const fetchMock = jest
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce({ ok: true, status: 200 } as Response)
    .mockResolvedValueOnce({ ok: false, status: 400 } as Response)
  const build = (projectToken: string) =>
    buildPostHogProductExporters({
      ...BASE,
      managed: { enabled: true, host: "https://us.i.posthog.com", projectToken },
      byo: { enabled: false, host: "", projectToken: "" },
    })[0]

  await expect(build("phc_success").export(EVENT)).resolves.toBeUndefined()
  await expect(build("phc_failure").export(EVENT)).rejects.toThrow("400")

  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(fetchMock.mock.calls[0][1]).toMatchObject({
    method: "POST",
    headers: { "content-type": "application/json" },
    keepalive: true,
    signal: expect.any(AbortSignal),
  })
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

it("keeps every request within the configured batch limit while a send is in flight", async () => {
  let releaseFirst: (() => void) | undefined
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  const bodies: CaptureBatchBody[] = []
  const postJson: PostHogPostJson = async (_url, body) => {
    bodies.push(JSON.parse(body) as CaptureBatchBody)
    if (bodies.length === 1) await firstBlocked
  }
  const [exporter] = buildPostHogProductExporters({
    ...BASE,
    flushIntervalMs: 60_000,
    batchSize: 2,
    managed: { enabled: true, host: "https://us.i.posthog.com", projectToken: "phc_managed" },
    byo: { enabled: false, host: "", projectToken: "" },
    postJson,
  })

  const pending = [exporter.export(EVENT), exporter.export(EVENT)]
  await Promise.resolve()
  pending.push(exporter.export(EVENT), exporter.export(EVENT), exporter.export(EVENT))
  releaseFirst?.()
  await Promise.all(pending)

  expect(bodies.map((body) => body.batch.length)).toEqual([2, 2, 1])
})

it("drops the oldest queued event when the bounded Product queue overflows", async () => {
  const [exporter] = buildPostHogProductExporters({
    ...BASE,
    flushIntervalMs: 60_000,
    batchSize: 20,
    maxQueuedEvents: 2,
    managed: { enabled: true, host: "https://us.i.posthog.com", projectToken: "phc_managed" },
    byo: { enabled: false, host: "", projectToken: "" },
    postJson: noopPostJson,
  })
  const oldest = exporter.export(EVENT)
  const second = exporter.export(EVENT)
  const third = exporter.export(EVENT)

  await expect(oldest).rejects.toThrow("queue overflow")
  expect(exporter.getHealth?.()).toMatchObject({
    status: "degraded",
    queueDepth: 2,
    droppedEntries: 1,
    lastError: "PostHog queue overflow",
  })

  exporter.close?.()
  await expect(second).rejects.toThrow("closed")
  await expect(third).rejects.toThrow("closed")
})

it("splits Product Analytics batches at the serialized byte limit", async () => {
  const maxBatchBytes = 1_200
  const bodies: string[] = []
  const postJson: PostHogPostJson = async (_url, body) => {
    bodies.push(body)
  }
  const [exporter] = buildPostHogProductExporters({
    ...BASE,
    batchSize: 2,
    maxBatchBytes,
    managed: { enabled: true, host: "https://us.i.posthog.com", projectToken: "phc_managed" },
    byo: { enabled: false, host: "", projectToken: "" },
    postJson,
  })
  const event = {
    ...EVENT,
    attributes: { ...EVENT.attributes, provider: "a".repeat(300) },
  }

  await Promise.all([exporter.export(event), exporter.export(event)])

  expect(bodies).toHaveLength(2)
  expect(bodies.every((body) => new TextEncoder().encode(body).byteLength <= maxBatchBytes)).toBe(
    true
  )
})

it("shrinks a multi-event batch after PostHog rejects it with 413", async () => {
  const bodies: CaptureBatchBody[] = []
  const tooLarge = Object.assign(new Error("PostHog capture failed with 413"), { status: 413 })
  const postJson: PostHogPostJson = async (_url, body) => {
    bodies.push(JSON.parse(body) as CaptureBatchBody)
    if (bodies.length === 1) throw tooLarge
  }
  const [exporter] = buildPostHogProductExporters({
    ...BASE,
    batchSize: 2,
    managed: { enabled: true, host: "https://us.i.posthog.com", projectToken: "phc_managed" },
    byo: { enabled: false, host: "", projectToken: "" },
    postJson,
  })

  await Promise.all([exporter.export(EVENT), exporter.export(EVENT)])

  expect(bodies.map((body) => body.batch.length)).toEqual([2, 1, 1])
  expect(bodies.slice(1).map((body) => body.batch[0].uuid)).toEqual(
    bodies[0].batch.map((event) => event.uuid)
  )
})

it("drops a single event that exceeds the serialized byte limit", async () => {
  const postJson = jest.fn<Promise<void>, [string, string]>(async () => {})
  const [exporter] = buildPostHogProductExporters({
    ...BASE,
    maxBatchBytes: 100,
    managed: { enabled: true, host: "https://us.i.posthog.com", projectToken: "phc_managed" },
    byo: { enabled: false, host: "", projectToken: "" },
    postJson,
  })

  await expect(exporter.export(EVENT)).rejects.toThrow("exceeds 100 byte limit")

  expect(postJson).not.toHaveBeenCalled()
  expect(exporter.getHealth?.()).toMatchObject({
    status: "degraded",
    queueDepth: 0,
    droppedEntries: 1,
    lastError: "PostHog payload exceeds 100 byte limit",
  })
})

it("drops a single event when PostHog still rejects it with 413", async () => {
  const tooLarge = Object.assign(new Error("PostHog capture failed with 413"), { status: 413 })
  const postJson = jest.fn<Promise<void>, [string, string]>(async () => {
    throw tooLarge
  })
  const [exporter] = buildPostHogProductExporters({
    ...BASE,
    managed: { enabled: true, host: "https://us.i.posthog.com", projectToken: "phc_managed" },
    byo: { enabled: false, host: "", projectToken: "" },
    postJson,
  })

  await expect(exporter.export(EVENT)).rejects.toThrow("413")

  expect(postJson).toHaveBeenCalledTimes(1)
  expect(exporter.getHealth?.()).toMatchObject({
    status: "degraded",
    queueDepth: 0,
    droppedEntries: 1,
    lastError: "PostHog capture failed with 413",
  })
})

it("rejects the events in a batch the destination refused", async () => {
  const postJson = jest.fn(async () => {
    throw new Error("PostHog capture failed with 401")
  })
  const [exporter] = buildPostHogProductExporters({
    ...BASE,
    managed: { enabled: true, host: "https://us.i.posthog.com", projectToken: "phc_managed" },
    byo: { enabled: false, host: "", projectToken: "" },
    postJson,
  })
  await expect(exporter.export(EVENT)).rejects.toThrow("401")
  expect(postJson).toHaveBeenCalledTimes(1)
  expect(exporter.getHealth?.()).toMatchObject({
    transport: "posthog-managed",
    status: "degraded",
    queueDepth: 0,
    droppedEntries: 1,
    lastError: "PostHog capture failed with 401",
  })
})

it("reports queued and successfully delivered Product Analytics events", async () => {
  const [exporter] = buildPostHogProductExporters({
    ...BASE,
    flushIntervalMs: 60_000,
    managed: { enabled: true, host: "https://us.i.posthog.com", projectToken: "phc_managed" },
    byo: { enabled: false, host: "", projectToken: "" },
    postJson: noopPostJson,
  })

  const pending = exporter.export(EVENT)
  expect(exporter.getHealth?.()).toMatchObject({
    status: "degraded",
    queueDepth: 1,
    droppedEntries: 0,
  })

  window.dispatchEvent(new Event("pagehide"))
  await pending
  expect(exporter.getHealth?.()).toMatchObject({
    status: "healthy",
    queueDepth: 0,
    droppedEntries: 0,
  })
  expect(exporter.getHealth?.().lastSuccessAt).toBeTruthy()
})

it("retries a transient PostHog failure before dropping the batch", async () => {
  const postJson = jest
    .fn<Promise<void>, [string, string]>()
    .mockRejectedValueOnce(new Error("PostHog capture failed with 503"))
    .mockResolvedValueOnce(undefined)
  const sleep = jest.fn(async () => undefined)
  const [exporter] = buildPostHogProductExporters({
    ...BASE,
    maxRetries: 2,
    retryBaseMs: 25,
    sleepImpl: sleep,
    managed: { enabled: true, host: "https://us.i.posthog.com", projectToken: "phc_managed" },
    byo: { enabled: false, host: "", projectToken: "" },
    postJson,
  })

  await expect(exporter.export(EVENT)).resolves.toBeUndefined()
  expect(postJson).toHaveBeenCalledTimes(2)
  expect(sleep).toHaveBeenCalledWith(25)
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

it("rejects credential-bearing hosts consistently", () => {
  expect(isValidPostHogProject("https://user:pass@us.i.posthog.com", "phc_project")).toBe(false)
  expect(isValidPostHogProject("https://us.i.posthog.com", "phc_project")).toBe(true)
  expect(isValidPostHogProject("https://us.i.posthog.com", "phc_")).toBe(false)
  expect(isValidPostHogProject("https://us.i.posthog.com", "phc_bad token")).toBe(false)
})

it("does not create a destination with an invalid PostHog distinct id", () => {
  const build = (installationId: string) =>
    buildPostHogProductExporters({
      ...BASE,
      installationId,
      managed: { enabled: true, host: "https://us.i.posthog.com", projectToken: "phc_managed" },
      byo: { enabled: false, host: "", projectToken: "" },
      postJson: noopPostJson,
    })

  expect(build("  ")).toEqual([])
  expect(build("x".repeat(201))).toEqual([])
  expect(build("jane.doe@example.com")).toEqual([])
  expect(build("installation-1")).toHaveLength(1)
})

it("rejects a final Product Analytics batch that contains PII", async () => {
  const postJson = jest.fn(async () => undefined)
  const [exporter] = buildPostHogProductExporters({
    ...BASE,
    managed: { enabled: true, host: "https://us.i.posthog.com", projectToken: "phc_managed" },
    byo: { enabled: false, host: "", projectToken: "" },
    postJson,
  })

  await expect(
    exporter.export({
      ...EVENT,
      attributes: { ...EVENT.attributes, provider: "jane.doe@example.com" },
    })
  ).rejects.toThrow("privacy gate")
  expect(postJson).not.toHaveBeenCalled()
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

it("replaces a live exporter when its delivery byte limit changes", async () => {
  const build = (maxBatchBytes: number) =>
    buildPostHogProductExporters({
      ...BASE,
      flushIntervalMs: 60_000,
      maxBatchBytes,
      managed: { enabled: true, host: "https://us.i.posthog.com", projectToken: "phc_managed" },
      byo: { enabled: false, host: "", projectToken: "" },
      postJson: noopPostJson,
    })[0]
  const first = build(1_000)
  const pending = first.export(EVENT)

  const second = build(2_000)

  expect(second).not.toBe(first)
  await expect(pending).rejects.toThrow("closed")
  const replacementPending = second.export(EVENT)
  window.dispatchEvent(new Event("pagehide"))
  await expect(replacementPending).resolves.toBeUndefined()
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

it("drains the queue during a normal runtime shutdown", async () => {
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

  await exporter.shutdown?.()

  await expect(pending).resolves.toBeUndefined()
  expect(postJson).toHaveBeenCalledTimes(1)
  await expect(exporter.export(EVENT)).rejects.toThrow("closed")
})

it("discards pending consent-scoped work without disabling the destination", async () => {
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
  const withdrawn = exporter.export(EVENT)

  exporter.discardPending?.()

  await expect(withdrawn).rejects.toThrow("consent")
  const afterOptIn = exporter.export(EVENT)
  window.dispatchEvent(new Event("pagehide"))
  await expect(afterOptIn).resolves.toBeUndefined()
  expect(postJson).toHaveBeenCalledTimes(1)
})

it("aborts an in-flight Product Analytics request when consent is withdrawn", async () => {
  let capturedSignal: AbortSignal | undefined
  const postJson: PostHogPostJson = async (_url, _body, signal) => {
    capturedSignal = signal
    await new Promise<void>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
    })
  }
  const [exporter] = buildPostHogProductExporters({
    ...BASE,
    managed: { enabled: true, host: "https://us.i.posthog.com", projectToken: "phc_managed" },
    byo: { enabled: false, host: "", projectToken: "" },
    postJson,
  })
  const inFlight = exporter.export(EVENT)
  await Promise.resolve()
  await Promise.resolve()

  exporter.discardPending?.()

  expect(capturedSignal?.aborted).toBe(true)
  await expect(inFlight).rejects.toThrow("consent")
})

it("normalizes the capture endpoint to the host origin", () => {
  expect(postHogCaptureEndpoint("https://us.i.posthog.com/some/path")).toBe(
    "https://us.i.posthog.com/batch/"
  )
  expect(postHogCaptureEndpoint("not a URL")).toBe("")
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
