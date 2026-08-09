/**
 * Browser E2E for the realtime voice lifecycle.
 *
 * The provider HTTP/WebSocket boundaries and browser audio primitives are
 * deterministic doubles, while the real settings store, adapter, transport,
 * controller, composer dialog and Dexie persistence remain in the path.
 */

import { expect, test, type Page, type WebSocketRoute } from "@/tests/e2e/fixtures/test"
import { ensureCogniaAccount, setCogniaSettings, waitForTestGlobals } from "../helpers/db-reset"

type Provider = "openai" | "google"

interface OpenAIMock {
  messages: Array<Record<string, unknown>>
  sockets: WebSocketRoute[]
  setAcceptReconnect(value: boolean): void
}

async function installBrowserAudio(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const node = () => ({ connect() {}, disconnect() {} })
    const tracks = [{ enabled: true, stop() {} }]
    const stream = {
      getAudioTracks: () => tracks,
      getTracks: () => tracks,
    }

    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        async getUserMedia() {
          return stream
        },
        async enumerateDevices() {
          return [
            { deviceId: "mic-default", groupId: "group-1", kind: "audioinput", label: "E2E mic" },
            { deviceId: "mic-backup", groupId: "group-2", kind: "audioinput", label: "Backup mic" },
          ]
        },
        addEventListener() {},
        removeEventListener() {},
      },
    })
    Object.defineProperty(navigator, "permissions", {
      configurable: true,
      value: {
        query: async () => ({ state: "granted", addEventListener() {}, removeEventListener() {} }),
      },
    })

    class MockAudioContext {
      readonly sampleRate: number
      readonly destination = node()
      readonly audioWorklet = { addModule: async () => undefined }
      state = "running"
      private clock = 0

      constructor(options?: { sampleRate?: number }) {
        this.sampleRate = options?.sampleRate ?? 24_000
      }

      get currentTime() {
        // Advance on observation so playback/truncation assertions are
        // deterministic without sleeping for wall-clock audio.
        this.clock += 0.05
        return this.clock
      }

      createMediaStreamSource() {
        return node()
      }

      createBuffer(_channels: number, length: number) {
        const data = new Float32Array(length)
        return { getChannelData: () => data }
      }

      createBufferSource() {
        return {
          ...node(),
          buffer: null,
          onended: null as (() => void) | null,
          start() {},
          stop() {},
        }
      }

      createGain() {
        return { ...node(), gain: { value: 1 } }
      }

      async suspend() {
        this.state = "suspended"
      }

      async resume() {
        this.state = "running"
      }

      async close() {
        this.state = "closed"
      }
    }

    class MockAudioWorkletNode {
      readonly port: {
        onmessage: ((event: { data: unknown }) => void) | null
        postMessage(): void
      }
      constructor() {
        let handler: ((event: { data: unknown }) => void) | null = null
        this.port = {
          get onmessage() {
            return handler
          },
          set onmessage(next) {
            handler = next
            if (next) {
              setTimeout(
                () =>
                  next({
                    data: { type: "frame", samples: new Float32Array(480), rms: 0.05 },
                  }),
                50
              )
            }
          },
          postMessage() {},
        }
      }
      connect() {}
      disconnect() {}
    }

    Object.assign(window, {
      AudioContext: MockAudioContext,
      webkitAudioContext: MockAudioContext,
      AudioWorkletNode: MockAudioWorkletNode,
    })
    URL.createObjectURL = () => "blob:cognia-e2e-audio-worklet"
    URL.revokeObjectURL = () => undefined
  })
}

function liveVoiceSettings(providers: Provider[]) {
  return {
    enabled: true,
    region: "global",
    deployments: providers.map((provider) => ({
      id: `${provider}-global`,
      provider,
      region: "global",
      enabled: true,
    })),
    preferredDeploymentId: `${providers[0]}-global`,
    fallbackEnabled: providers.length > 1,
    maxCandidates: providers.length,
    connectTimeoutMs: 1_000,
    historyTurnLimit: 12,
    historyCharacterLimit: 8_000,
  }
}

async function configureLiveVoice(page: Page, providers: Provider[]): Promise<void> {
  await installBrowserAudio(page)
  await page.goto("/", { waitUntil: "domcontentloaded" })
  await ensureCogniaAccount(page)
  await page.goto("about:blank")
  await page.goto("/", { waitUntil: "domcontentloaded" })
  await waitForTestGlobals(page, 30_000)
  await setCogniaSettings(page, { liveVoice: liveVoiceSettings(providers) })

  // Save through the real web keyring UI. Use the in-app route so the unlocked
  // account and the lazily loaded provider-key mirror stay in memory.
  const openSettings = page.getByTestId("guild-open-settings")
  await expect(openSettings).toBeVisible({ timeout: 30_000 })
  await openSettings.click()
  await expect(page).toHaveURL(/\/settings/)
  await page.getByText("Speech", { exact: true }).first().click()
  await expect(page.getByText("Live voice", { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  })
  const inputs = page.locator('input[type="password"]')
  await expect(inputs).toHaveCount(providers.length)
  for (let index = 0; index < providers.length; index++) {
    const input = inputs.nth(index)
    await input.fill(`e2e-${providers[index]}-key`)
    const keyEditor = input.locator('xpath=ancestor::div[contains(@class,"space-y-2")][1]')
    await keyEditor.getByRole("button", { name: "Save", exact: true }).click()
  }
  await page.getByRole("button", { name: "Back to chat" }).click()
  await expect(page).toHaveURL(/\/$/)
}

async function openNewChat(page: Page): Promise<void> {
  await page.getByRole("button", { name: "New chat" }).first().click()
  const picker = page.getByRole("dialog", { name: /pick a character/i })
  await expect(picker).toBeVisible({ timeout: 10_000 })
  await picker.getByRole("option").first().click()
  await expect(page.getByRole("button", { name: "Start live voice" })).toBeVisible({
    timeout: 30_000,
  })
}

async function mockOpenAIToken(page: Page, fail = false): Promise<void> {
  await page.route("https://api.openai.com/v1/realtime/client_secrets", async (route) => {
    if (fail) {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: '{"error":"bad key"}',
      })
      return
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ value: "e2e-ephemeral-openai", expires_at: 4_102_444_800 }),
    })
  })
}

async function mockOpenAISocket(
  page: Page,
  options: { closeBeforeFirstFrame?: boolean } = {}
): Promise<OpenAIMock> {
  const messages: Array<Record<string, unknown>> = []
  const sockets: WebSocketRoute[] = []
  let acceptReconnect = true

  await page.routeWebSocket(/api\.openai\.com\/v1\/realtime/, (socket) => {
    sockets.push(socket)
    const connection = sockets.length
    socket.onMessage((message) => {
      const parsed = JSON.parse(String(message)) as Record<string, unknown>
      messages.push(parsed)
      if (parsed.type !== "session.update") return
      if (connection > 1 && !acceptReconnect) {
        void socket.close({ code: 1011, reason: "e2e reconnect failure" })
        return
      }
      setTimeout(
        () => {
          socket.send(
            JSON.stringify({ type: "session.updated", session: { id: `s-${connection}` } })
          )
          if (connection === 1 && options.closeBeforeFirstFrame) {
            setTimeout(() => void socket.close({ code: 1011, reason: "e2e pre-frame loss" }), 5)
          }
        },
        connection > 1 ? 150 : 0
      )
    })
  })

  return {
    messages,
    sockets,
    setAcceptReconnect(value) {
      acceptReconnect = value
    },
  }
}

async function mockGoogle(page: Page): Promise<{ sockets: WebSocketRoute[] }> {
  const sockets: WebSocketRoute[] = []
  await page.route(/generativelanguage\.googleapis\.com\/v1alpha\/auth_tokens/, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ name: "e2e-google-token", expireTime: "2100-01-01T00:00:00Z" }),
    })
  })
  await page.routeWebSocket(
    /generativelanguage\.googleapis\.com.*BidiGenerateContentConstrained/,
    (socket) => {
      sockets.push(socket)
      socket.onMessage((message) => {
        const parsed = JSON.parse(String(message)) as Record<string, unknown>
        if (parsed.setup) socket.send(JSON.stringify({ setupComplete: {} }))
      })
    }
  )
  return { sockets }
}

test.describe("web — live voice closed loop", () => {
  test.describe.configure({ timeout: 120_000 })

  test("starts, finalizes transcripts, interrupts output, and restores the locked provider", async ({
    page,
  }) => {
    await mockOpenAIToken(page)
    const provider = await mockOpenAISocket(page)
    await configureLiveVoice(page, ["openai"])
    await openNewChat(page)

    await page.getByRole("button", { name: "Start live voice" }).click()
    await expect(page.getByText("Listening…", { exact: true })).toBeVisible()
    const first = provider.sockets[0]
    first.send(
      JSON.stringify({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "user-1",
        transcript: "first realtime turn",
      })
    )
    first.send(
      JSON.stringify({
        type: "response.output_audio_transcript.done",
        response_id: "response-1",
        item_id: "assistant-1",
        transcript: "first realtime answer",
      })
    )
    first.send(
      JSON.stringify({
        type: "response.done",
        response: { id: "response-1", status: "completed" },
      })
    )
    await expect(page.getByText("first realtime turn", { exact: true })).toBeVisible()
    await expect(page.getByText("first realtime answer", { exact: true })).toBeVisible()

    first.send(
      JSON.stringify({
        type: "response.output_audio.delta",
        response_id: "response-2",
        item_id: "assistant-2",
        delta: "AAAAAA==",
      })
    )
    first.send(JSON.stringify({ type: "input_audio_buffer.speech_started", item_id: "user-2" }))
    await expect
      .poll(() => provider.messages.map((message) => message.type))
      .toContain("response.cancel")
    await expect
      .poll(() => provider.messages.map((message) => message.type))
      .toContain("conversation.item.truncate")
    await expect
      .poll(() => provider.messages.map((message) => message.type))
      .toContain("input_audio_buffer.append")

    await first.close({ code: 1011, reason: "e2e network loss" })
    await expect(page.getByText("Reconnecting…", { exact: true })).toBeVisible()
    await expect.poll(() => provider.sockets.length).toBe(2)
    await expect(page.getByText("Listening…", { exact: true })).toBeVisible()
    await expect(page.getByText("first realtime turn", { exact: true })).toBeVisible()
    expect(provider.sockets).toHaveLength(2)
  })

  test("falls back when the ready provider drops before the first audio frame", async ({
    page,
  }) => {
    await mockOpenAIToken(page)
    const openai = await mockOpenAISocket(page, { closeBeforeFirstFrame: true })
    const google = await mockGoogle(page)
    await configureLiveVoice(page, ["openai", "google"])
    await openNewChat(page)

    await page.getByRole("button", { name: "Start live voice" }).click()
    await expect(page.getByText("Listening…", { exact: true })).toBeVisible({ timeout: 10_000 })
    await expect.poll(() => google.sockets.length).toBe(1)
    expect(openai.sockets).toHaveLength(1)
  })

  test("exhausts automatic recovery and lets the user reset the retry budget", async ({ page }) => {
    await mockOpenAIToken(page)
    const provider = await mockOpenAISocket(page)
    await configureLiveVoice(page, ["openai"])
    await openNewChat(page)

    await page.getByRole("button", { name: "Start live voice" }).click()
    await expect(page.getByText("Listening…", { exact: true })).toBeVisible()
    await expect
      .poll(() => provider.messages.map((message) => message.type))
      .toContain("input_audio_buffer.append")
    provider.setAcceptReconnect(false)
    await provider.sockets[0].close({ code: 1011, reason: "e2e persistent loss" })

    const retry = page.getByRole("button", { name: "Try again" })
    await expect(retry).toBeVisible({ timeout: 10_000 })
    await expect.poll(() => provider.sockets.length).toBe(4)
    provider.setAcceptReconnect(true)
    await retry.click()
    await expect.poll(() => provider.sockets.length).toBe(5)
    await expect(page.getByText("Listening…", { exact: true })).toBeVisible()
  })
})
