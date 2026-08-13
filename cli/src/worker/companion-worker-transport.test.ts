import { createHash, generateKeyPairSync, X509Certificate } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import https from "node:https"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import tls from "node:tls"
import { WebSocketServer } from "ws"

import {
  CompanionWorkerTransport,
  CompanionWorkerTransportError,
  normalizeSpkiFingerprint,
  verifyPinnedPeer,
} from "./companion-worker-transport"

describe("CompanionWorkerTransport pinning", () => {
  it("normalizes SHA-256 SPKI fingerprints", () => {
    const hex = "ab".repeat(32)
    expect(normalizeSpkiFingerprint(`sha256:${hex.match(/../g)!.join(":")}`)).toEqual(
      Buffer.from(hex, "hex")
    )
    expect(() => normalizeSpkiFingerprint("not-a-pin")).toThrow(CompanionWorkerTransportError)
  })

  it("compares the exported peer SPKI in constant-size digest form", () => {
    const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
    const digest = createHash("sha256")
      .update(publicKey.export({ type: "spki", format: "der" }))
      .digest("hex")
    const socket = {
      getPeerX509Certificate: () => ({ publicKey }),
    } as unknown as tls.TLSSocket

    expect(() => verifyPinnedPeer(socket, digest)).not.toThrow()
    expect(() => verifyPinnedPeer(socket, "00".repeat(32))).toThrow("does not match")
    expect(() =>
      verifyPinnedPeer(
        { getPeerX509Certificate: () => undefined } as unknown as tls.TLSSocket,
        digest
      )
    ).toThrow("did not provide")
  })

  it("uses the standard fetch/CA path when no fingerprint is configured", async () => {
    const original = global.fetch
    const fetchMock = jest.fn(async () => new Response("ok"))
    global.fetch = fetchMock as never
    try {
      const transport = new CompanionWorkerTransport()
      await transport.fetch("https://public.example/health", { method: "GET" })
      expect(fetchMock).toHaveBeenCalledWith(
        "https://public.example/health",
        expect.not.objectContaining({ serverFingerprint: expect.anything() })
      )
    } finally {
      global.fetch = original
    }
  })

  it("accepts a matching self-signed pin for HTTPS and WSS and rejects a wrong pin", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "cognia-worker-tls-"))
    const keyPath = path.join(directory, "key.pem")
    const certPath = path.join(directory, "cert.pem")
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost",
        "-days",
        "1",
      ],
      { stdio: "ignore" }
    )
    const certificate = readFileSync(certPath)
    const pin = createHash("sha256")
      .update(new X509Certificate(certificate).publicKey.export({ type: "spki", format: "der" }))
      .digest("hex")
    const server = https.createServer(
      { key: readFileSync(keyPath), cert: certificate },
      (request, response) => {
        const chunks: Buffer[] = []
        request.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
        request.on("end", () => {
          response.writeHead(200, {
            "content-type": "application/json",
            "set-cookie": ["a=1", "b=2"],
          })
          response.end(
            JSON.stringify({
              ok: true,
              method: request.method,
              body: Buffer.concat(chunks).toString("utf8"),
            })
          )
        })
      }
    )
    const wss = new WebSocketServer({ server })
    wss.on("connection", (socket) => {
      socket.send("worker-frame")
      socket.on("message", () => socket.send(Buffer.from("binary-frame")))
    })
    await new Promise<void>((resolve) => server.listen(0, "localhost", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("missing TLS test address")
    const transport = new CompanionWorkerTransport()
    try {
      const response = await transport.fetch(`https://localhost:${address.port}/health`, {
        method: "GET",
        serverFingerprint: pin,
      })
      await expect(response.json()).resolves.toEqual({ ok: true, method: "GET", body: "" })
      const posted = await transport.fetch(`https://localhost:${address.port}/ticket`, {
        method: "POST",
        body: "payload",
        serverFingerprint: `sha256-${pin}`,
      })
      await expect(posted.json()).resolves.toEqual({ ok: true, method: "POST", body: "payload" })
      await expect(
        transport.fetch(`https://localhost:${address.port}/health`, {
          method: "GET",
          serverFingerprint: "00".repeat(32),
        })
      ).rejects.toThrow("does not match")
      await expect(
        transport.fetch(`http://localhost:${address.port}/health`, {
          method: "GET",
          serverFingerprint: pin,
        })
      ).rejects.toThrow("requires an HTTPS")
      await expect(
        transport.fetch(`https://localhost:${address.port}/health`, {
          method: "POST",
          body: new URLSearchParams("unsupported=true") as never,
          serverFingerprint: pin,
        })
      ).rejects.toThrow("unsupported request body")
      expect(() =>
        transport.openWebSocket(`ws://localhost:${address.port}/ws/worker`, pin)
      ).toThrow("requires a WSS")

      const socket = transport.openWebSocket(`wss://localhost:${address.port}/ws/worker`, pin)
      const messages: unknown[] = []
      const closed = new Promise<void>((resolve) =>
        socket.addEventListener("close", () => resolve())
      )
      const firstMessage = new Promise<void>((resolve, reject) => {
        socket.addEventListener("message", (event) => {
          messages.push(event.data)
          if (messages.length === 1) resolve()
        })
        socket.addEventListener("error", (event) => reject(event.error))
      })
      await firstMessage
      expect(messages[0]).toBe("worker-frame")
      expect(socket.bufferedAmount).toBe(0)
      socket.send("ping")
      await new Promise<void>((resolve) => {
        const poll = () => {
          if (messages.length >= 2) resolve()
          else setImmediate(poll)
        }
        poll()
      })
      expect(Buffer.isBuffer(messages[1])).toBe(true)
      socket.close()
      await closed

      const wrongPinSocket = transport.openWebSocket(
        `wss://localhost:${address.port}/ws/worker`,
        "00".repeat(32)
      )
      await expect(
        new Promise((resolve, reject) => {
          wrongPinSocket.addEventListener("open", resolve)
          wrongPinSocket.addEventListener("error", (event) => reject(event.error))
        })
      ).rejects.toThrow("does not match")

      const standardCaSocket = transport.openWebSocket(`wss://localhost:${address.port}/ws/worker`)
      await expect(
        new Promise((resolve, reject) => {
          standardCaSocket.addEventListener("open", resolve)
          standardCaSocket.addEventListener("error", (event) => reject(event.error))
        })
      ).rejects.toThrow()
    } finally {
      wss.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
