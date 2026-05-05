/**
 * Mock Telegram Bot API server for E2E connector tests — Task 113.
 *
 * Spins up a minimal HTTP server that implements the subset of the
 * Telegram Bot API used by the Telegram adapter:
 *
 *   GET /bot<token>/getMe            → static bot info
 *   GET /bot<token>/getUpdates       → queued updates (long-poll)
 *   POST /bot<token>/sendMessage     → capture sent messages
 *
 * Usage:
 *   const server = createTelegramMockServer()
 *   await server.start(9876)
 *   server.pushUpdate(makeTelegramMessage("hello"))
 *   const sent = await server.waitForSend()
 *   await server.stop()
 *
 * NOTE: Requires `express` (`pnpm add -D express @types/express`) and
 * `@playwright/test` (`pnpm add -D @playwright/test`) to be installed.
 * These are not yet in the project lockfile — install them before running
 * E2E tests:
 *
 *   pnpm add -D express @types/express @playwright/test
 *
 * Installation is deferred because Playwright browser downloads require
 * network access during CI setup.
 */

// Conditional import so the file can be parsed without express installed.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const createExpressApp = () => require("express")() as import("express").Application

import type { Server } from "http"

// ── Telegram Bot API shapes (minimal subset) ──────────────────────────────────

export interface TelegramUser {
  id: number
  is_bot: boolean
  first_name: string
  username?: string
}

export interface TelegramChat {
  id: number
  type: "private" | "group" | "supergroup" | "channel"
  title?: string
  username?: string
}

export interface TelegramMessage {
  message_id: number
  from: TelegramUser
  chat: TelegramChat
  date: number
  text?: string
}

export interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
}

export interface SentMessage {
  chatId: number | string
  text: string
  params: Record<string, unknown>
}

// ── Server factory ────────────────────────────────────────────────────────────

export interface TelegramMockServer {
  /** Start listening on the given port. */
  start(port: number): Promise<void>
  /** Stop the server. */
  stop(): Promise<void>
  /** Push a synthetic update into the getUpdates queue. */
  pushUpdate(update: TelegramUpdate): void
  /** Wait until at least one sendMessage call is captured, then return it. */
  waitForSend(timeoutMs?: number): Promise<SentMessage>
  /** All sendMessage payloads received so far. */
  readonly sentMessages: SentMessage[]
  /** The port the server is listening on. */
  readonly port: number
}

export function createTelegramMockServer(): TelegramMockServer {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app = createExpressApp() as any
  let server: Server | null = null
  let _port = 0
  const updateQueue: TelegramUpdate[] = []
  const sentMessages: SentMessage[] = []
  let nextUpdateId = 1
  const sendResolvers: Array<(msg: SentMessage) => void> = []

  // Static bot identity
  const BOT_INFO: TelegramUser = {
    id: 123456789,
    is_bot: true,
    first_name: "MockBot",
    username: "mock_cognia_bot",
  }

  // GET /bot<token>/getMe
  app.get("/bot:token/getMe", (_req: unknown, res: { json: (d: unknown) => void }) => {
    res.json({ ok: true, result: BOT_INFO })
  })

  // GET /bot<token>/getUpdates
  app.get("/bot:token/getUpdates", (_req: unknown, res: { json: (d: unknown) => void }) => {
    const updates = [...updateQueue]
    updateQueue.length = 0
    res.json({ ok: true, result: updates })
  })

  // POST /bot<token>/sendMessage
  app.post(
    "/bot:token/sendMessage",
    (req: { body: Record<string, unknown> }, res: { json: (d: unknown) => void }) => {
      const { chat_id, text, ...rest } = req.body as {
        chat_id: number | string
        text: string
        [k: string]: unknown
      }
      const sent: SentMessage = { chatId: chat_id, text, params: rest }
      sentMessages.push(sent)

      // Resolve any waiters
      const resolver = sendResolvers.shift()
      if (resolver) resolver(sent)

      res.json({
        ok: true,
        result: {
          message_id: Date.now(),
          from: BOT_INFO,
          chat: { id: chat_id, type: "private" },
          date: Math.floor(Date.now() / 1000),
          text,
        },
      })
    }
  )

  return {
    async start(port: number): Promise<void> {
      await new Promise<void>((resolve) => {
        server = app.listen(port, () => {
          _port = port
          resolve()
        })
      })
    },

    async stop(): Promise<void> {
      if (!server) return
      await new Promise<void>((resolve, reject) => {
        server!.close((err) => (err ? reject(err) : resolve()))
      })
      server = null
    },

    pushUpdate(update: TelegramUpdate): void {
      updateQueue.push({ ...update, update_id: update.update_id ?? nextUpdateId++ })
    },

    waitForSend(timeoutMs = 5_000): Promise<SentMessage> {
      // Already have a sent message waiting
      if (sentMessages.length > 0) {
        return Promise.resolve(sentMessages[sentMessages.length - 1])
      }
      return new Promise<SentMessage>((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = sendResolvers.indexOf(resolve)
          if (idx !== -1) sendResolvers.splice(idx, 1)
          reject(new Error(`waitForSend timed out after ${timeoutMs} ms`))
        }, timeoutMs)

        sendResolvers.push((msg) => {
          clearTimeout(timer)
          resolve(msg)
        })
      })
    },

    get sentMessages() {
      return sentMessages
    },

    get port() {
      return _port
    },
  }
}

// ── Factory helpers ───────────────────────────────────────────────────────────

/** Build a realistic-looking Telegram text message update. */
export function makeTelegramUpdate(text: string, chatId = 100, fromId = 200): TelegramUpdate {
  return {
    update_id: 0, // overwritten by pushUpdate
    message: {
      message_id: Math.floor(Math.random() * 100_000),
      from: {
        id: fromId,
        is_bot: false,
        first_name: "TestUser",
        username: "testuser",
      },
      chat: {
        id: chatId,
        type: "private",
      },
      date: Math.floor(Date.now() / 1000),
      text,
    },
  }
}
