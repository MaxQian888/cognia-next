import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Readable, Writable } from "node:stream"

import type { HandoffEnvelope } from "@cognia/agent"

import type { ResolvedConfig } from "../config/schema"
import { CompanionWorkerTransportError } from "./companion-worker-transport"
import {
  buildWorkerManifest,
  connectWorker,
  enrollWorker,
  loadWorkerDeviceConfig,
  validateWorkerHandoffExecution,
  isRetryableWorkerConnectionError,
  workerSocketUrl,
} from "./worker-connect"

const config = {
  provider: "openai",
  providers: {
    openai: { apiKey: "secret" },
    anthropic: {},
  },
  model: "gpt-test",
  agentBackend: "builtin",
} as unknown as ResolvedConfig

const rawIdentity = JSON.stringify({
  baseUrl: "https://brain.example",
  deviceId: "worker-a",
  tenantId: "tenant-a",
  devicePrivateKeyJwk: { kty: "EC", d: "private" },
  serverVersion: "1.0.0",
})

function openingSocket() {
  const listeners = new Map<string, Array<(event: Record<string, unknown>) => void>>()
  const socket = {
    bufferedAmount: 0,
    send: jest.fn(),
    close: jest.fn(),
    addEventListener(type: string, listener: (event: Record<string, unknown>) => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener])
      if (type === "open") queueMicrotask(() => listener({}))
    },
  }
  return {
    socket,
    emit(type: string, event: Record<string, unknown> = {}) {
      listeners.get(type)?.forEach((listener) => listener(event))
    },
  }
}

describe("worker connect contract", () => {
  it("builds an opaque readiness manifest without credential values or local paths", () => {
    const manifest = buildWorkerManifest(config, ["repository:project:repo"], 2)
    expect(manifest).toMatchObject({
      manifestVersion: 1,
      runtime: "builtin",
      models: ["gpt-test"],
      maxActiveTurns: 2,
      credentialProfileRefs: ["credential:openai"],
      workspaceBindingRefs: ["repository:project:repo"],
      taskWorkspace: { enabled: true },
      executionProfile: {
        profileVersion: 1,
        backendId: "builtin",
        modelBindings: { primary: "gpt-test" },
        deploymentRefs: ["provider:openai"],
      },
    })
    expect(manifest.hardCapabilities).toEqual(
      expect.arrayContaining(["streaming", "session.multi-turn", "worker-dispatch-v1"])
    )
    expect(manifest.sandbox.capabilities).toContain("filesystem")
    expect(JSON.stringify(manifest)).not.toContain("secret")
    expect(JSON.stringify(manifest)).not.toContain("/Users/")
    expect(buildWorkerManifest(config, [], Number.NaN).maxActiveTurns).toBe(1)
    expect(buildWorkerManifest(config, [], 99).maxActiveTurns).toBe(32)
    expect(buildWorkerManifest(config, [], -4).maxActiveTurns).toBe(1)
    expect(
      buildWorkerManifest(
        { ...config, providers: { ...config.providers, openai: {} } } as ResolvedConfig,
        []
      ).credentialProfileRefs
    ).toEqual([])
  })

  it("enrolls through the shared pinned transport and persists an owner-only identity", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "cognia-worker-enroll-"))
    const deviceConfigPath = path.join(directory, "nested", "worker.json")
    const identity = JSON.parse(rawIdentity)
    const transportFetch = jest.fn()
    const register = jest.fn(async () => identity)
    try {
      await expect(
        enrollWorker({
          baseUrl: identity.baseUrl,
          tenantId: identity.tenantId,
          enrollment: "enrollment-code",
          displayName: "Worker A",
          deviceConfigPath,
          serverFingerprint: "aa".repeat(32),
          register: register as never,
          transport: { fetch: transportFetch } as never,
        })
      ).resolves.toEqual(identity)
      expect(register).toHaveBeenCalledWith(
        expect.objectContaining({ serverFingerprint: "aa".repeat(32) }),
        transportFetch
      )
      expect(JSON.parse(readFileSync(deviceConfigPath, "utf8"))).toEqual(identity)
      expect(statSync(deviceConfigPath).mode & 0o077).toBe(0)
      expect(loadWorkerDeviceConfig(deviceConfigPath)).toEqual(identity)
      await enrollWorker({
        baseUrl: identity.baseUrl,
        tenantId: identity.tenantId,
        enrollment: "enrollment-code-2",
        displayName: "Worker B",
        deviceConfigPath: path.join(directory, "worker-b.json"),
        register: register as never,
      })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("puts only a short-lived ticket in the worker WebSocket URL", () => {
    const url = workerSocketUrl("https://brain.example/base?token=long-lived", "once")
    expect(url).toBe("wss://brain.example/ws/worker?ticket=once")
    expect(url).not.toContain("long-lived")
    expect(workerSocketUrl("http://brain.local/base", "once")).toBe(
      "ws://brain.local/ws/worker?ticket=once"
    )
  })

  it("requires a private DPoP identity and owner-only file permissions", () => {
    const raw = JSON.stringify({
      baseUrl: "https://brain.example",
      deviceId: "worker-a",
      tenantId: "tenant-a",
      devicePrivateKeyJwk: { kty: "EC", d: "private" },
      serverVersion: "1.0.0",
    })
    expect(
      loadWorkerDeviceConfig("worker.json", {
        stat: () => ({ mode: 0o100600 }),
        readFile: () => raw,
      })
    ).toMatchObject({ deviceId: "worker-a" })
    expect(() =>
      loadWorkerDeviceConfig("worker.json", {
        stat: () => ({ mode: 0o100644 }),
        readFile: () => raw,
      })
    ).toThrow(/must not be readable/)
    expect(() =>
      loadWorkerDeviceConfig("worker.json", {
        stat: () => ({ mode: 0o100600 }),
        readFile: () => JSON.stringify({ baseUrl: "https://brain.example" }),
      })
    ).toThrow(/DPoP/)
    expect(
      loadWorkerDeviceConfig("worker.json", {
        stat: () => ({ mode: 0o100600 }),
        readFile: () =>
          JSON.stringify({
            baseUrl: "http://brain.local",
            deviceId: "worker-a",
            accountId: "account-a",
            devicePrivateKeyJwk: { kty: "EC", d: "private" },
          }),
      })
    ).toMatchObject({ accountId: "account-a" })
  })

  it("revalidates frozen execution requirements before creating a workspace", () => {
    const manifest = buildWorkerManifest(config, ["repository:project:repo"])
    const execution = {
      mode: "orchestrated" as const,
      runtimeAdapter: manifest.executionProfile!.runtimeAdapter,
      deploymentRef: "provider:openai",
      credentialProfileRef: "credential:openai",
      modelBindingRef: "gpt-test",
      requiredCapabilities: manifest.executionProfile!.capabilities,
      requiredSandboxCapabilities: ["filesystem"],
    }
    const handoff = {
      envelopeVersion: 1 as const,
      identity: {
        parentRunId: "parent",
        childRunId: "child",
        depth: 1,
        parentChain: ["parent"],
      },
      task: { prompt: "test" },
      execution,
      createdAt: "2026-08-12T00:00:00.000Z",
    }
    expect(validateWorkerHandoffExecution(manifest, handoff)).toEqual([])
    expect(
      validateWorkerHandoffExecution(manifest, {
        ...handoff,
        execution: { ...execution, requiredCapabilities: ["checkpoint"] },
      })
    ).toContain("capability checkpoint is unavailable")

    expect(
      validateWorkerHandoffExecution({ ...manifest, executionProfile: undefined }, handoff)
    ).toEqual(["execution profile is missing"])
    expect(
      validateWorkerHandoffExecution(manifest, {
        ...handoff,
        execution: {
          ...execution,
          runtimeAdapter: "external",
          modelBindingRef: "missing-model",
          deploymentRef: "provider:missing",
          credentialProfileRef: "credential:missing",
          requiredCapabilities: ["checkpoint"],
          requiredSandboxCapabilities: ["network"],
        },
      })
    ).toEqual([
      "runtime adapter external is unavailable",
      "model binding missing-model is unavailable",
      "deployment provider:missing is unavailable",
      "credential profile credential:missing is unavailable",
      "capability checkpoint is unavailable",
      "sandbox capability network is unavailable",
    ])
    expect(
      validateWorkerHandoffExecution(manifest, {
        ...handoff,
        execution: { ...execution, modelBindingRef: "inherit", requiredCapabilities: undefined },
      })
    ).toEqual([])
  })

  it("retries network, 429, and 5xx failures but fails fast on config or pin errors", () => {
    expect(isRetryableWorkerConnectionError(new Error("HTTP 429"))).toBe(true)
    expect(isRetryableWorkerConnectionError(new Error("HTTP 503"))).toBe(true)
    expect(isRetryableWorkerConnectionError(new Error("connect ECONNREFUSED"))).toBe(true)
    expect(
      isRetryableWorkerConnectionError(
        new TypeError("fetch failed", {
          cause: Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" }),
        })
      )
    ).toBe(true)
    expect(isRetryableWorkerConnectionError(new Error("worker manifest is malformed"))).toBe(false)
    expect(isRetryableWorkerConnectionError("socket disconnected")).toBe(true)
    expect(
      isRetryableWorkerConnectionError(
        new CompanionWorkerTransportError("transport_error", "network failed")
      )
    ).toBe(true)
    expect(
      isRetryableWorkerConnectionError(
        new CompanionWorkerTransportError("tls_pin_mismatch", "pin failed")
      )
    ).toBe(false)
  })

  it("honors one-shot mode and retry cancellation", async () => {
    const oneShot = openingSocket()
    const createServer = jest.fn(() => ({ serve: jest.fn(async () => undefined) }))
    await connectWorker({
      deviceConfigPath: "worker.json",
      runtimeConfig: config,
      home: "/tmp/cognia-worker-test",
      workspace: { list: jest.fn(async () => []), begin: jest.fn() } as never,
      reconnect: false,
      stat: () => ({ mode: 0o100600 }),
      readFile: () => rawIdentity,
      issueTicket: jest.fn(async () => ({ ticket: "once", expiresAt: 1 })),
      wsFactory: () => oneShot.socket,
      createService: jest.fn(() => ({ close: jest.fn() })) as never,
      createServer: createServer as never,
    })
    expect(createServer).toHaveBeenCalledTimes(1)

    const controller = new AbortController()
    const wait = jest.fn(async () => controller.abort())
    const diagnostic = { write: jest.fn() }
    await connectWorker({
      deviceConfigPath: "worker.json",
      runtimeConfig: config,
      home: "/tmp/cognia-worker-test",
      workspace: { list: jest.fn(async () => []), begin: jest.fn() } as never,
      signal: controller.signal,
      stat: () => ({ mode: 0o100600 }),
      readFile: () => rawIdentity,
      issueTicket: jest.fn(async () => {
        throw new Error("HTTP 503")
      }),
      diagnostic: diagnostic as never,
      wait,
      random: () => 0,
    })
    expect(wait).toHaveBeenCalledWith(125, controller.signal)
    expect(diagnostic.write).toHaveBeenCalledWith(expect.stringContaining("worker reconnecting"))

    const abortedDuringTicket = new AbortController()
    await expect(
      connectWorker({
        deviceConfigPath: "worker.json",
        runtimeConfig: config,
        home: "/tmp/cognia-worker-test",
        workspace: { list: jest.fn(async () => []), begin: jest.fn() } as never,
        signal: abortedDuringTicket.signal,
        stat: () => ({ mode: 0o100600 }),
        readFile: () => rawIdentity,
        issueTicket: jest.fn(async () => {
          abortedDuringTicket.abort()
          throw new Error("connection stopped")
        }),
      })
    ).resolves.toBeUndefined()

    const abortedDuringWait = new AbortController()
    await expect(
      connectWorker({
        deviceConfigPath: "worker.json",
        runtimeConfig: config,
        home: "/tmp/cognia-worker-test",
        workspace: { list: jest.fn(async () => []), begin: jest.fn() } as never,
        signal: abortedDuringWait.signal,
        stat: () => ({ mode: 0o100600 }),
        readFile: () => rawIdentity,
        issueTicket: jest.fn(async () => {
          throw new Error("HTTP 503")
        }),
        wait: jest.fn(async () => {
          abortedDuringWait.abort()
          throw new Error("cancelled")
        }),
      })
    ).resolves.toBeUndefined()
  })

  it("enforces socket frame boundaries and uses the transport WebSocket adapter", async () => {
    const connectSocket = async (opened: ReturnType<typeof openingSocket>) => {
      let output!: Writable
      let input!: Readable
      const controller = new AbortController()
      const transport = {
        fetch: jest.fn(),
        openWebSocket: jest.fn(() => opened.socket),
      }
      await connectWorker({
        deviceConfigPath: "worker.json",
        runtimeConfig: config,
        home: "/tmp/cognia-worker-test",
        workspace: { list: jest.fn(async () => []), begin: jest.fn() } as never,
        signal: controller.signal,
        reconnect: false,
        stat: () => ({ mode: 0o100600 }),
        readFile: () => rawIdentity,
        issueTicket: jest.fn(async () => ({ ticket: "once", expiresAt: 1 })),
        transport: transport as never,
        createService: jest.fn(() => ({ close: jest.fn() })) as never,
        createServer: jest.fn((serverOptions) => {
          output = serverOptions.output
          input = serverOptions.input
          return { serve: jest.fn(async () => undefined) }
        }) as never,
      })
      return { controller, input, output, transport }
    }
    const write = async (output: Writable, frame: string | Buffer) => {
      output.once("error", () => undefined)
      return new Promise<Error | undefined>((resolve) =>
        output.write(frame, (error) => resolve(error ?? undefined))
      )
    }

    const opened = openingSocket()
    const connected = await connectSocket(opened)
    expect(connected.transport.openWebSocket).toHaveBeenCalledWith(
      "wss://brain.example/ws/worker?ticket=once",
      undefined
    )
    const inbound = new Promise<string>((resolve) =>
      connected.input.once("data", (chunk) => resolve(String(chunk)))
    )
    opened.emit("message", { data: '{"jsonrpc":"2.0"}' })
    await expect(inbound).resolves.toBe('{"jsonrpc":"2.0"}\n')
    await expect(write(connected.output, '{"jsonrpc":"2.0"}\n')).resolves.toBeUndefined()
    expect(opened.socket.send).toHaveBeenCalledWith('{"jsonrpc":"2.0"}')
    opened.emit("message", { data: Buffer.from("binary") })
    opened.emit("message", { data: "two\nframes" })
    opened.emit("message", { data: "carriage\rreturn" })
    expect(opened.socket.close).toHaveBeenCalledWith(1002, "invalid Agent RPC frame")
    opened.emit("close")
    opened.emit("error")
    connected.controller.abort()

    const buffered = openingSocket()
    buffered.socket.bufferedAmount = 32 * 1024 * 1024
    await expect(write((await connectSocket(buffered)).output, "frame")).resolves.toEqual(
      expect.objectContaining({ message: expect.stringContaining("outbound buffer limit") })
    )

    const throwing = openingSocket()
    throwing.socket.send
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw "send failed"
      })
    await expect(write((await connectSocket(throwing)).output, "frame")).resolves.toEqual(
      expect.objectContaining({ message: "send failed" })
    )

    const throwingError = openingSocket()
    throwingError.socket.send
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("send Error")
      })
    await expect(write((await connectSocket(throwingError)).output, "frame")).resolves.toEqual(
      expect.objectContaining({ message: "send Error" })
    )

    const withoutBufferAmount = openingSocket()
    delete (withoutBufferAmount.socket as { bufferedAmount?: number }).bufferedAmount
    await expect(
      write((await connectSocket(withoutBufferAmount)).output, "frame")
    ).resolves.toBeUndefined()

    const invalid = openingSocket()
    await expect(write((await connectSocket(invalid)).output, "\n")).resolves.toEqual(
      expect.objectContaining({ message: expect.stringContaining("exactly one frame") })
    )
  })

  it("surfaces a non-Error WebSocket handshake failure", async () => {
    const socket = {
      send: jest.fn(),
      close: jest.fn(),
      addEventListener(type: string, listener: (event: Record<string, unknown>) => void) {
        if (type === "error") queueMicrotask(() => listener({ error: "failed" }))
      },
    }
    await expect(
      connectWorker({
        deviceConfigPath: "worker.json",
        runtimeConfig: config,
        home: "/tmp/cognia-worker-test",
        workspace: { list: jest.fn(async () => []), begin: jest.fn() } as never,
        reconnect: false,
        stat: () => ({ mode: 0o100600 }),
        readFile: () => rawIdentity,
        issueTicket: jest.fn(async () => ({ ticket: "once", expiresAt: 1 })),
        wsFactory: () => socket,
      })
    ).rejects.toThrow("worker WebSocket failed")

    const error = new Error("TLS handshake failed")
    const errorSocket = {
      send: jest.fn(),
      close: jest.fn(),
      addEventListener(type: string, listener: (event: Record<string, unknown>) => void) {
        if (type === "error") queueMicrotask(() => listener({ error }))
      },
    }
    await expect(
      connectWorker({
        deviceConfigPath: "worker.json",
        runtimeConfig: config,
        home: "/tmp/cognia-worker-test",
        workspace: { list: jest.fn(async () => []), begin: jest.fn() } as never,
        reconnect: false,
        stat: () => ({ mode: 0o100600 }),
        readFile: () => rawIdentity,
        issueTicket: jest.fn(async () => ({ ticket: "once", expiresAt: 1 })),
        wsFactory: () => errorSocket,
      })
    ).rejects.toThrow("TLS handshake failed")
  })

  it("closes an in-flight WebSocket handshake when cancelled", async () => {
    const controller = new AbortController()
    const socket = {
      send: jest.fn(),
      close: jest.fn(),
      addEventListener: jest.fn(),
    }
    const connecting = connectWorker({
      deviceConfigPath: "worker.json",
      runtimeConfig: config,
      home: "/tmp/cognia-worker-test",
      workspace: { list: jest.fn(async () => []), begin: jest.fn() } as never,
      signal: controller.signal,
      reconnect: false,
      stat: () => ({ mode: 0o100600 }),
      readFile: () => rawIdentity,
      issueTicket: jest.fn(async () => ({ ticket: "once", expiresAt: 1 })),
      wsFactory: () => socket,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    controller.abort()
    await expect(connecting).resolves.toBeUndefined()
    expect(socket.close).toHaveBeenCalledWith(1000, "worker stopping")
  })

  it("fails fast for non-retryable connection errors and propagates retry wait failures", async () => {
    const base = {
      deviceConfigPath: "worker.json",
      runtimeConfig: config,
      home: "/tmp/cognia-worker-test",
      workspace: { list: jest.fn(async () => []), begin: jest.fn() } as never,
      stat: () => ({ mode: 0o100600 }),
      readFile: () => rawIdentity,
    }
    await expect(
      connectWorker({
        ...base,
        issueTicket: jest.fn(async () => {
          throw new Error("manifest invalid")
        }),
      })
    ).rejects.toThrow("manifest invalid")
    await expect(
      connectWorker({
        ...base,
        issueTicket: jest.fn(async () => {
          throw new Error("HTTP 429")
        }),
        wait: jest.fn(async () => {
          throw new Error("wait failed")
        }),
      })
    ).rejects.toThrow("wait failed")
  })

  it("validates the handoff before Task Workspace begin and maps the begin request", async () => {
    const opened = openingSocket()
    const begin = jest.fn(async () => ({ executionRoot: "/tmp/execution-root" }))
    let resolveWorkspace!: (handoff: HandoffEnvelope, commandId: string) => Promise<string>
    await connectWorker({
      deviceConfigPath: "worker.json",
      runtimeConfig: config,
      home: "/tmp/cognia-worker-test",
      workspace: {
        list: jest.fn(async () => [{ bindingRef: "repository:project:repo" }]),
        begin,
      } as never,
      reconnect: false,
      stat: () => ({ mode: 0o100600 }),
      readFile: () => rawIdentity,
      issueTicket: jest.fn(async () => ({ ticket: "once", expiresAt: 1 })),
      wsFactory: () => opened.socket,
      createService: jest.fn((serviceOptions) => {
        resolveWorkspace = serviceOptions.workerDispatch!.resolveHandoffWorkspace
        return { close: jest.fn() }
      }) as never,
      createServer: jest.fn(() => ({ serve: jest.fn(async () => undefined) })) as never,
    })
    const manifest = buildWorkerManifest(config, ["repository:project:repo"])
    const handoff: HandoffEnvelope = {
      envelopeVersion: 1,
      identity: {
        parentRunId: "parent",
        childRunId: "child",
        teamId: "team",
        taskId: "task",
        depth: 1,
        parentChain: ["parent"],
      },
      task: { prompt: "test" },
      execution: {
        mode: "orchestrated",
        runtimeAdapter: manifest.executionProfile!.runtimeAdapter,
        modelBindingRef: manifest.executionProfile!.modelBindings.primary,
        deploymentRef: manifest.executionProfile!.deploymentRefs[0],
        credentialProfileRef: manifest.credentialProfileRefs[0],
        requiredCapabilities: manifest.executionProfile!.capabilities,
      },
      resources: [{ kind: "repository", ref: "repository:project:repo" }],
      createdAt: "2026-08-12T00:00:00.000Z",
    }

    await expect(resolveWorkspace(handoff, "command-1")).resolves.toBe("/tmp/execution-root")
    expect(begin).toHaveBeenCalledWith(
      "repository:project:repo",
      expect.objectContaining({
        taskId: "task",
        sessionId: "child",
        runId: "command-1",
        parentRunId: "parent",
        agentId: "team",
      })
    )
    await expect(
      resolveWorkspace(
        { ...handoff, execution: { ...handoff.execution, runtimeAdapter: "external" } },
        "command-2"
      )
    ).rejects.toThrow("execution profile mismatch")
    await expect(resolveWorkspace({ ...handoff, resources: [] }, "command-3")).rejects.toThrow(
      "missing repository ref"
    )
    await expect(
      resolveWorkspace(
        {
          ...handoff,
          resources: [{ kind: "repository", ref: "repository:missing" }],
        },
        "command-4"
      )
    ).rejects.toThrow("repository:missing")
    begin.mockResolvedValueOnce({ executionRoot: "" })
    await expect(resolveWorkspace(handoff, "command-5")).rejects.toThrow("execution root")
    await expect(
      resolveWorkspace(
        {
          ...handoff,
          identity: { ...handoff.identity, taskId: undefined, teamId: undefined },
        },
        "command-6"
      )
    ).resolves.toBe("/tmp/execution-root")
    expect(begin).toHaveBeenLastCalledWith(
      "repository:project:repo",
      expect.objectContaining({ taskId: "child", agentId: "agent-team" })
    )
  })

  it("remints a single-use ticket and recreates RPC streams on every reconnect", async () => {
    const controller = new AbortController()
    const issueTicket = jest
      .fn()
      .mockResolvedValueOnce({ ticket: "once-1", expiresAt: 1 })
      .mockResolvedValueOnce({ ticket: "once-2", expiresAt: 2 })
    const urls: string[] = []
    const wsFactory = (url: string) => {
      urls.push(url)
      const listeners = new Map<string, Array<(event: Record<string, unknown>) => void>>()
      const socket = {
        send: jest.fn(),
        close: jest.fn(),
        addEventListener(type: string, listener: (event: Record<string, unknown>) => void) {
          listeners.set(type, [...(listeners.get(type) ?? []), listener])
          if (type === "open") queueMicrotask(() => listener({}))
        },
      }
      return socket
    }
    let serves = 0
    const createServer = jest.fn(() => ({
      serve: async () => {
        serves += 1
        if (serves === 2) controller.abort()
      },
      close: jest.fn(),
    }))
    await connectWorker({
      deviceConfigPath: "worker.json",
      runtimeConfig: config,
      home: "/tmp/cognia-worker-test",
      workspace: { list: jest.fn(async () => []), begin: jest.fn() } as never,
      signal: controller.signal,
      stat: () => ({ mode: 0o100600 }),
      readFile: () => rawIdentity,
      issueTicket,
      wsFactory,
      createService: jest.fn(() => ({ close: jest.fn() })) as never,
      createServer: createServer as never,
      wait: jest.fn(async () => undefined),
    })

    expect(issueTicket).toHaveBeenCalledTimes(2)
    expect(createServer).toHaveBeenCalledTimes(2)
    expect(urls).toEqual([
      "wss://brain.example/ws/worker?ticket=once-1",
      "wss://brain.example/ws/worker?ticket=once-2",
    ])
  })
})
