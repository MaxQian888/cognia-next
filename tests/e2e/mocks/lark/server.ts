/**
 * Mock Lark / Feishu Open API for E2E workflow tests.
 *
 * Implements the subset of open.feishu.cn endpoints the Lark connector
 * adapter (`lib/connectors/adapters/lark/`) hits during outbound sends and
 * inbound webhook simulation:
 *
 *   POST /open-apis/auth/v3/tenant_access_token/internal — auth bootstrap
 *   POST /open-apis/im/v1/messages                        — send text/card
 *   PATCH /open-apis/im/v1/messages/:id                   — recall/edit
 *   POST /open-apis/im/v1/messages/:id/reply              — threaded reply
 *   GET  /open-apis/im/v1/messages/:id                    — read receipt
 *   POST /open-apis/im/v1/chats                           — create chat
 *   POST /open-apis/contact/v3/users/batch_get_id         — open_id resolve
 *
 * Specs configure scenarios (success / quota / forbidden / network drop),
 * inspect captured payloads, and push synthetic inbound events through
 * `pushInboundEvent` for the connector bus.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const createExpressApp = () => require("express")() as import("express").Application

import type { Server } from "http"

export interface LarkSendPayload {
  receive_id_type: string
  receive_id: string
  msg_type: "text" | "post" | "interactive" | string
  content: string
}

export interface CapturedLarkCall {
  method: string
  path: string
  body: unknown
  headers: Record<string, string>
}

export type LarkScenario =
  | { kind: "ok" }
  | { kind: "quota" }
  | { kind: "forbidden" }
  | { kind: "invalid-token" }
  | { kind: "server-error"; status: number; code: number; message: string }

export interface MockLarkServer {
  start(port?: number): Promise<void>
  stop(): Promise<void>
  readonly port: number
  readonly baseUrl: string

  setScenario(scenario: LarkScenario): void
  setTenantAccessToken(token: string, expireSeconds?: number): void

  waitForSend(timeoutMs?: number): Promise<LarkSendPayload>
  /** All /open-apis/im/v1/messages POST payloads captured. */
  readonly sentMessages: LarkSendPayload[]
  readonly capturedCalls: CapturedLarkCall[]
  reset(): void
}

export function createMockLarkServer(): MockLarkServer {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app = createExpressApp() as any
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const express = require("express") as typeof import("express")
  app.use(express.json({ limit: "2mb" }))

  let server: Server | null = null
  let _port = 0
  let scenario: LarkScenario = { kind: "ok" }
  let tenantAccessToken = "t-mock-token"
  let tokenExpire = 7200
  const sentMessages: LarkSendPayload[] = []
  const capturedCalls: CapturedLarkCall[] = []
  const sendResolvers: Array<(payload: LarkSendPayload) => void> = []

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const capture = (req: any) => {
    capturedCalls.push({
      method: req.method,
      path: req.path,
      body: req.body,
      headers: Object.fromEntries(
        Object.entries(req.headers ?? {}).map(([k, v]) => [
          k.toLowerCase(),
          Array.isArray(v) ? v.join(",") : String(v),
        ])
      ),
    })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const errorFor = (res: any): boolean => {
    switch (scenario.kind) {
      case "quota":
        res.status(200).json({ code: 230001, msg: "Quota exceeded" })
        return true
      case "forbidden":
        res.status(403).json({ code: 99991663, msg: "Permission denied" })
        return true
      case "invalid-token":
        res.status(401).json({ code: 99991671, msg: "Invalid tenant_access_token" })
        return true
      case "server-error":
        res.status(scenario.status).json({ code: scenario.code, msg: scenario.message })
        return true
      default:
        return false
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.post("/open-apis/auth/v3/tenant_access_token/internal", (req: any, res: any) => {
    capture(req)
    if (errorFor(res)) return
    res.json({ code: 0, msg: "ok", tenant_access_token: tenantAccessToken, expire: tokenExpire })
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.post("/open-apis/im/v1/messages", (req: any, res: any) => {
    capture(req)
    if (errorFor(res)) return
    const body = req.body as LarkSendPayload
    sentMessages.push(body)
    const resolver = sendResolvers.shift()
    if (resolver) resolver(body)
    res.json({
      code: 0,
      msg: "ok",
      data: {
        message_id: `om_${Math.random().toString(36).slice(2, 10)}`,
        root_id: "",
        parent_id: "",
        msg_type: body.msg_type,
        create_time: String(Date.now()),
        update_time: String(Date.now()),
        deleted: false,
        updated: false,
        chat_id: body.receive_id,
        sender: { id: "bot", id_type: "app_id", sender_type: "app", tenant_key: "tenant" },
        body: { content: body.content },
      },
    })
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.patch("/open-apis/im/v1/messages/:id", (req: any, res: any) => {
    capture(req)
    if (errorFor(res)) return
    res.json({ code: 0, msg: "ok", data: { message_id: req.params.id } })
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.post("/open-apis/im/v1/messages/:id/reply", (req: any, res: any) => {
    capture(req)
    if (errorFor(res)) return
    res.json({
      code: 0,
      msg: "ok",
      data: {
        message_id: `om_${Math.random().toString(36).slice(2, 10)}`,
        root_id: req.params.id,
        parent_id: req.params.id,
      },
    })
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.get("/open-apis/im/v1/messages/:id", (req: any, res: any) => {
    capture(req)
    if (errorFor(res)) return
    res.json({
      code: 0,
      msg: "ok",
      data: { items: [{ message_id: req.params.id, body: { content: "{}" } }] },
    })
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.post("/open-apis/im/v1/chats", (req: any, res: any) => {
    capture(req)
    if (errorFor(res)) return
    res.json({
      code: 0,
      msg: "ok",
      data: {
        chat_id: `oc_${Math.random().toString(36).slice(2, 10)}`,
        invitor: "bot",
        ...(req.body as Record<string, unknown>),
      },
    })
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.post("/open-apis/contact/v3/users/batch_get_id", (req: any, res: any) => {
    capture(req)
    if (errorFor(res)) return
    const items = ((req.body as { emails?: string[]; mobiles?: string[] }).emails ?? []).map(
      (e, i) => ({
        email: e,
        user_id: `u_${i}_${e.replace(/[^a-z0-9]/gi, "")}`,
      })
    )
    res.json({ code: 0, msg: "ok", data: { user_list: items } })
  })

  return {
    async start(port = 0): Promise<void> {
      await new Promise<void>((resolve) => {
        server = app.listen(port, () => {
          const addr = server!.address()
          _port = typeof addr === "object" && addr ? addr.port : port
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
    get port() {
      return _port
    },
    get baseUrl() {
      return `http://127.0.0.1:${_port}`
    },
    setScenario(next) {
      scenario = next
    },
    setTenantAccessToken(token, expireSeconds = 7200) {
      tenantAccessToken = token
      tokenExpire = expireSeconds
    },
    waitForSend(timeoutMs = 5_000): Promise<LarkSendPayload> {
      if (sentMessages.length > 0) return Promise.resolve(sentMessages[sentMessages.length - 1])
      return new Promise<LarkSendPayload>((resolve, reject) => {
        const timer = setTimeout(() => {
          const i = sendResolvers.indexOf(resolve)
          if (i !== -1) sendResolvers.splice(i, 1)
          reject(new Error(`waitForSend timed out after ${timeoutMs} ms`))
        }, timeoutMs)
        sendResolvers.push((p) => {
          clearTimeout(timer)
          resolve(p)
        })
      })
    },
    get sentMessages() {
      return sentMessages
    },
    get capturedCalls() {
      return capturedCalls
    },
    reset() {
      scenario = { kind: "ok" }
      sentMessages.length = 0
      capturedCalls.length = 0
      sendResolvers.length = 0
    },
  }
}
