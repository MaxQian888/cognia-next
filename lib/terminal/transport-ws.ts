"use client"

/** LAN terminal session adapter backed by the durable terminal host. */

import { BaseTerminalSession, TerminalSessionError } from "./base-session"
import {
  LanTerminalHostConnection,
  WanTerminalHostConnection,
  type TerminalHostConnection,
} from "./host-connection"
import {
  decodeTerminalJson,
  EMPTY_SESSION_ID,
  makeTerminalJsonFrame,
  makeTerminalFrame,
  splitTerminalStreamFrames,
  TerminalFrameKind,
  type TerminalErrorCode,
  type TerminalFrame,
} from "./protocol"
import { hasWebCompanionTarget } from "@/lib/platform/web-companion"
import { isCapacitor } from "@/lib/tauri"
import { getActiveRemoteEndpoint } from "@/lib/tauri/transport-routing"
import { issueSocketTicket } from "@/lib/tauri/companion-auth"
import type { CompanionConfig } from "@/lib/tauri/companion-storage"

import type { IntegrationEvent, SessionInfo, SpawnRequest, TerminalReplayGap } from "./types"

export type CompanionEndpoint = Pick<
  CompanionConfig,
  | "baseUrl"
  | "deviceId"
  | "devicePrivateKeyJwk"
  | "deviceKeyThumbprint"
  | "accountId"
  | "serverVersion"
  | "serverFingerprint"
>

export type CompanionEndpointResolver = () => Promise<CompanionEndpoint | null>

const defaultResolver: CompanionEndpointResolver = async () => {
  const remote = getActiveRemoteEndpoint()
  if (remote) {
    return remote
  }
  // Capacitor and the cloud companion (ADR-0059 C1) both keep their pairing in
  // the companion target book. `pickCompanionStorage()` is already
  // shell-agnostic — it resolves the Browser Vault backend in a browser and the
  // secure-storage backend on mobile — so the only thing this gate decides is
  // whether a pairing is expected to exist at all.
  if (!isCapacitor() && !hasWebCompanionTarget()) return null
  const { pickCompanionStorage } = await import("@/lib/tauri/companion-storage")
  const config = await pickCompanionStorage().load()
  return config
}

let endpointResolver: CompanionEndpointResolver = defaultResolver

interface TerminalDataChannelBinding {
  channel: RTCDataChannel
  clientId?: string
}

type TerminalDataChannelResolver = () => Promise<TerminalDataChannelBinding | null>

const defaultTerminalDataChannelResolver: TerminalDataChannelResolver = async () => {
  const [{ getActiveRemoteTransport }, transportModule] = await Promise.all([
    import("@/lib/tauri/transport-routing"),
    import("@/lib/tauri/transport-instance"),
  ])
  const candidate = getActiveRemoteTransport() ?? transportModule.transport
  const capable = candidate as {
    getTerminalDataChannel?: () => RTCDataChannel | null
    getTerminalClientId?: () => string | null
  }
  const channel = capable.getTerminalDataChannel?.() ?? null
  return channel ? { channel, clientId: capable.getTerminalClientId?.() ?? undefined } : null
}

let terminalDataChannelResolver = defaultTerminalDataChannelResolver
const wanConnections = new WeakMap<RTCDataChannel, WanTerminalHostConnection>()

export function configureCompanionEndpointResolver(resolver: CompanionEndpointResolver): void {
  endpointResolver = resolver
}

export function __resetEndpointResolverForTesting(): void {
  endpointResolver = defaultResolver
}

export function __setTerminalDataChannelResolverForTesting(
  resolver?: () => RTCDataChannel | null | Promise<RTCDataChannel | null>
): void {
  terminalDataChannelResolver = resolver
    ? async () => {
        const channel = await resolver()
        return channel ? { channel } : null
      }
    : defaultTerminalDataChannelResolver
}

interface SocketTicket {
  ticket: string
  expiresAt: number
}

type SocketTicketIssuer = (endpoint: CompanionEndpoint) => Promise<SocketTicket>

const defaultTicketIssuer: SocketTicketIssuer = async (endpoint) => {
  try {
    return await issueSocketTicket(endpoint, "terminal")
  } catch (error) {
    throw new TerminalSessionError(
      "unauthorized",
      error instanceof Error ? error.message : "terminal socket ticket request failed"
    )
  }
}

let ticketIssuer: SocketTicketIssuer = defaultTicketIssuer
let webSocketFactory: (url: string) => WebSocket = (url) => new WebSocket(url)

export function __setSocketTicketIssuerForTesting(issuer?: SocketTicketIssuer): void {
  ticketIssuer = issuer ?? defaultTicketIssuer
}

export function __setWebSocketFactoryForTesting(
  factory: (url: string) => WebSocket | null = (url) => new WebSocket(url)
): void {
  webSocketFactory = (url) => {
    const socket = factory(url)
    if (!socket) throw new Error("test factory returned null")
    return socket
  }
}

export type TransportState = "connected" | "reconnecting" | "gone"
type TransportStateListener = (state: TransportState) => void

const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000]
const RECONNECT_BUDGET_MS = 5 * 60 * 1_000
const REQUEST_TIMEOUT_MS = 15_000
const encoder = new TextEncoder()

type PendingRequest = {
  resolve: (frame: TerminalFrame) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

type RemoteConnectionFactory = () => Promise<TerminalHostConnection>

export class RemoteTerminalSession extends BaseTerminalSession {
  info: SessionInfo

  private connection: TerminalHostConnection
  private readonly req: SpawnRequest
  private readonly connectionFactory: RemoteConnectionFactory
  private sequence = BigInt(1)
  private lastOutputSequence = BigInt(0)
  private readonly pending = new Map<bigint, PendingRequest>()
  private readonly transportStateListeners = new Set<TransportStateListener>()
  private pendingWrites: Uint8Array[] = []
  private intentionalClose = false
  private reconnectStartedAt: number | null = null
  private backoffIndex = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private ownedControllerId: string | null = null
  private takingControl = false
  private connectionUnsubscribers: Array<() => void> = []

  private constructor(
    req: SpawnRequest,
    connection: TerminalHostConnection,
    connectionFactory: RemoteConnectionFactory
  ) {
    super()
    this.req = req
    this.connection = connection
    this.connectionFactory = connectionFactory
    this.info = {
      id: EMPTY_SESSION_ID,
      projectId: req.projectId ?? null,
      extensionId: req.extensionId ?? null,
      origin: "remote",
      shell: req.shell,
    }
    this.wireConnection(connection)
  }

  static async spawn(req: SpawnRequest): Promise<RemoteTerminalSession> {
    const endpoint = await endpointResolver()
    if (!endpoint) {
      throw new TerminalSessionError("unpaired", "terminal host is not paired")
    }
    const connectionFactory = () => openLanConnection(endpoint)
    return RemoteTerminalSession.spawnWithConnection(req, connectionFactory)
  }

  static async spawnWan(req: SpawnRequest): Promise<RemoteTerminalSession> {
    return RemoteTerminalSession.spawnWithConnection(req, openWanConnection)
  }

  static async listLan(): Promise<SessionInfo[]> {
    const endpoint = await endpointResolver()
    if (!endpoint) throw new TerminalSessionError("unpaired", "terminal host is not paired")
    return RemoteTerminalSession.listWithConnection(() => openLanConnection(endpoint))
  }

  static async listWan(): Promise<SessionInfo[]> {
    return RemoteTerminalSession.listWithConnection(openWanConnection)
  }

  static async reattachLan(sessionId: string, resumeAfter = 0): Promise<RemoteTerminalSession> {
    const endpoint = await endpointResolver()
    if (!endpoint) throw new TerminalSessionError("unpaired", "terminal host is not paired")
    return RemoteTerminalSession.reattachWithConnection(sessionId, resumeAfter, () =>
      openLanConnection(endpoint)
    )
  }

  static async reattachWan(sessionId: string, resumeAfter = 0): Promise<RemoteTerminalSession> {
    return RemoteTerminalSession.reattachWithConnection(sessionId, resumeAfter, openWanConnection)
  }

  private static async spawnWithConnection(
    req: SpawnRequest,
    connectionFactory: RemoteConnectionFactory
  ): Promise<RemoteTerminalSession> {
    const connection = await connectionFactory()
    const session = new RemoteTerminalSession(req, connection, connectionFactory)
    try {
      const response = await session.sendCommand(TerminalFrameKind.Spawn, EMPTY_SESSION_ID, {
        profileId: req.profileId ?? "default",
      })
      session.info = decodeTerminalJson<SessionInfo>(response)
      session.ownedControllerId = session.info.currentController ?? null
      session.dispatchControlState({
        role: "controller",
        controllerId: session.info.currentController ?? null,
      })
      return session
    } catch (error) {
      session.intentionalClose = true
      session.disposeConnectionListeners()
      await session.closeOwnedConnection()
      throw error
    }
  }

  private static async listWithConnection(
    connectionFactory: RemoteConnectionFactory
  ): Promise<SessionInfo[]> {
    const connection = await connectionFactory()
    const session = new RemoteTerminalSession(
      { shell: "", rows: 1, cols: 1 },
      connection,
      connectionFactory
    )
    try {
      const response = await session.sendCommand(TerminalFrameKind.List, EMPTY_SESSION_ID)
      const snapshot = decodeTerminalJson<{ sessions: SessionInfo[] }>(response)
      return snapshot.sessions
    } finally {
      session.intentionalClose = true
      session.disposeConnectionListeners()
      await session.closeOwnedConnection()
    }
  }

  private static async reattachWithConnection(
    sessionId: string,
    resumeAfter: number,
    connectionFactory: RemoteConnectionFactory
  ): Promise<RemoteTerminalSession> {
    const connection = await connectionFactory()
    const session = new RemoteTerminalSession(
      { shell: "", rows: 1, cols: 1 },
      connection,
      connectionFactory
    )
    try {
      const response = await session.sendCommand(TerminalFrameKind.Attach, sessionId, {
        resumeAfter: Math.max(0, Math.floor(resumeAfter)),
      })
      session.info = decodeTerminalJson<SessionInfo>(response)
      session.ownedControllerId =
        session.info.currentController === connection.clientId
          ? (session.info.currentController ?? null)
          : null
      session.dispatchControlState({
        role: session.ownedControllerId ? "controller" : "viewer",
        controllerId: session.info.currentController ?? null,
      })
      return session
    } catch (error) {
      session.intentionalClose = true
      session.disposeConnectionListeners()
      await session.closeOwnedConnection()
      throw error
    }
  }

  onTransportState(listener: TransportStateListener): () => void {
    this.transportStateListeners.add(listener)
    return () => this.transportStateListeners.delete(listener)
  }

  async write(data: Uint8Array | string): Promise<void> {
    const bytes = typeof data === "string" ? encoder.encode(data) : data
    if (this.connection.state !== "connected") {
      if (!this.isExited && this.pendingWrites.length < 256) this.pendingWrites.push(bytes)
      return
    }
    for (const frame of splitTerminalStreamFrames(
      TerminalFrameKind.Stdin,
      this.info.id,
      this.nextSequence(),
      bytes
    )) {
      await this.connection.send(frame)
    }
  }

  async resize(rows: number, cols: number): Promise<void> {
    await this.sendCommand(TerminalFrameKind.Resize, this.info.id, {
      rows: Math.max(1, Math.floor(rows)),
      cols: Math.max(1, Math.floor(cols)),
    })
  }

  async detach(): Promise<void> {
    if (this.intentionalClose) return
    this.intentionalClose = true
    this.cancelReconnect()
    try {
      await this.sendCommand(TerminalFrameKind.Detach, this.info.id)
    } finally {
      this.disposeConnectionListeners()
      await this.closeOwnedConnection()
    }
  }

  async takeControl(): Promise<void> {
    this.takingControl = true
    try {
      await this.sendCommand(TerminalFrameKind.TakeControl, this.info.id)
    } finally {
      this.takingControl = false
    }
  }

  async releaseControl(): Promise<void> {
    await this.sendCommand(TerminalFrameKind.ReleaseControl, this.info.id)
    this.ownedControllerId = null
    this.dispatchControlState({ role: "viewer", controllerId: null, reason: "released" })
  }

  async kill(): Promise<void> {
    if (this.isExited) return
    this.intentionalClose = true
    this.cancelReconnect()
    try {
      await this.sendCommand(TerminalFrameKind.Kill, this.info.id)
    } finally {
      this.disposeConnectionListeners()
      await this.closeOwnedConnection()
      this.handleExit(null)
    }
  }

  private wireConnection(connection: TerminalHostConnection): void {
    this.connectionUnsubscribers.push(
      connection.onFrame((frame) => this.onFrame(frame)),
      connection.onState((state) => {
        if (state === "closed" && !this.intentionalClose && !this.isExited) {
          this.rejectPending(new TerminalSessionError("host_offline", "terminal connection closed"))
          this.scheduleReconnect()
        }
      })
    )
  }

  private onFrame(frame: TerminalFrame): void {
    if (frame.sequence > this.lastOutputSequence && isStreamEvent(frame.kind)) {
      this.lastOutputSequence = frame.sequence
    }
    const pending = this.pending.get(frame.sequence)
    if (pending && isResponse(frame.kind)) {
      this.pending.delete(frame.sequence)
      clearTimeout(pending.timeout)
      if (frame.kind === TerminalFrameKind.Error) {
        const error = decodeTerminalJson<{ code: TerminalErrorCode; message: string }>(frame)
        pending.reject(new TerminalSessionError(error.code, error.message))
      } else {
        pending.resolve(frame)
      }
      return
    }
    if (frame.sessionId !== this.info.id) return

    switch (frame.kind) {
      case TerminalFrameKind.Stdout:
        this.dispatchData(frame.payload)
        break
      case TerminalFrameKind.Integration:
        this.dispatchIntegration(decodeTerminalJson<IntegrationEvent>(frame))
        break
      case TerminalFrameKind.Exit: {
        const { code } = decodeTerminalJson<{ code: number | null }>(frame)
        this.intentionalClose = true
        this.cancelReconnect()
        this.handleExit(code)
        this.disposeConnectionListeners()
        void this.closeOwnedConnection()
        break
      }
      case TerminalFrameKind.ControllerChanged: {
        const { controller } = decodeTerminalJson<{ controller: string | null }>(frame)
        if (controller === this.connection.clientId || (controller && this.takingControl)) {
          this.ownedControllerId = controller
        } else if (controller !== this.ownedControllerId) {
          this.ownedControllerId = null
        }
        this.dispatchControlState({
          role:
            controller !== null && controller === this.ownedControllerId ? "controller" : "viewer",
          controllerId: controller,
          reason: controller === null ? "released" : "takeover",
        })
        break
      }
      case TerminalFrameKind.ReplayGap:
        this.dispatchReplayGap(decodeTerminalJson<TerminalReplayGap>(frame))
        break
      case TerminalFrameKind.SessionSnapshot:
        // Sequence 0 is the host's unsolicited roster / lease refresh
        // (ADR-0133); replies to our own requests carry the request's
        // sequence and are settled by `sendCommand`.
        if (frame.sequence === BigInt(0)) {
          this.applySessionSnapshot(decodeTerminalJson<SessionInfo>(frame))
        }
        break
      case TerminalFrameKind.Error: {
        const error = decodeTerminalJson<{ code: TerminalErrorCode; message: string }>(frame)
        if (error.code === "replay_gap") return
        console.warn(`remote-terminal(${this.info.id}): ${error.code}: ${error.message}`)
        break
      }
      default:
        break
    }
  }

  private async sendCommand(
    kind: TerminalFrameKind,
    sessionId: string,
    value?: unknown
  ): Promise<TerminalFrame> {
    if (this.connection.state !== "connected") {
      throw new TerminalSessionError("host_offline", "terminal connection is not open")
    }
    const sequence = this.nextSequence()
    const frame =
      value === undefined
        ? makeTerminalFrame(kind, { sessionId, sequence })
        : makeTerminalJsonFrame(kind, value, { sessionId, sequence })
    const response = new Promise<TerminalFrame>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(sequence)
        reject(new TerminalSessionError("host_offline", "terminal host request timed out"))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(sequence, { resolve, reject, timeout })
    })
    try {
      await this.connection.send(frame)
    } catch (error) {
      const request = this.pending.get(sequence)
      if (request) {
        clearTimeout(request.timeout)
        this.pending.delete(sequence)
        request.reject(error instanceof Error ? error : new Error(String(error)))
      }
    }
    return response
  }

  private nextSequence(): bigint {
    if (this.connection.nextSequence) return this.connection.nextSequence()
    const current = this.sequence
    this.sequence += BigInt(1)
    return current
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timeout)
      request.reject(error)
    }
    this.pending.clear()
  }

  private scheduleReconnect(): void {
    if (this.intentionalClose || this.isExited || this.reconnectTimer) return
    if (this.reconnectStartedAt === null) {
      this.reconnectStartedAt = Date.now()
      this.backoffIndex = 0
      this.emitTransportState("reconnecting")
    }
    if (Date.now() - this.reconnectStartedAt >= RECONNECT_BUDGET_MS) {
      this.emitTransportState("gone")
      this.handleExit(null)
      return
    }
    const delay = BACKOFF_MS[Math.min(this.backoffIndex, BACKOFF_MS.length - 1)]!
    this.backoffIndex += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.attemptReconnect()
    }, delay)
  }

  private async attemptReconnect(): Promise<void> {
    try {
      const connection = await this.connectionFactory()
      this.disposeConnectionListeners()
      this.connection = connection
      this.wireConnection(connection)
      const response = await this.sendCommand(TerminalFrameKind.Attach, this.info.id, {
        resumeAfter: Number(this.lastOutputSequence),
      })
      this.info = decodeTerminalJson<SessionInfo>(response)
      this.reconnectStartedAt = null
      this.backoffIndex = 0
      this.emitTransportState("connected")
      await this.flushPendingWrites()
    } catch {
      this.scheduleReconnect()
    }
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.reconnectStartedAt = null
    this.backoffIndex = 0
  }

  private async flushPendingWrites(): Promise<void> {
    const writes = this.pendingWrites
    this.pendingWrites = []
    for (const bytes of writes) await this.write(bytes)
  }

  private emitTransportState(state: TransportState): void {
    for (const listener of this.transportStateListeners) listener(state)
  }

  private async closeOwnedConnection(): Promise<void> {
    // WAN is one multiplexed channel shared by every visible terminal tab.
    // Detaching one session must not disconnect its sibling attachments.
    if (this.connection.transport !== "wan") await this.connection.close()
  }

  private disposeConnectionListeners(): void {
    const unsubscribers = this.connectionUnsubscribers
    this.connectionUnsubscribers = []
    for (const unsubscribe of unsubscribers) unsubscribe()
  }
}

async function openLanConnection(endpoint: CompanionEndpoint): Promise<TerminalHostConnection> {
  const ticket = await ticketIssuer(endpoint)
  if (ticket.expiresAt <= Date.now()) {
    throw new TerminalSessionError("unauthorized", "terminal socket ticket expired")
  }
  const url = new URL("/ws/terminal", toWsBase(endpoint.baseUrl))
  url.searchParams.set("ticket", ticket.ticket)
  const connection = new LanTerminalHostConnection(
    url.toString(),
    webSocketFactory,
    endpoint.deviceId ? `companion:${endpoint.deviceId}` : undefined
  )
  await connection.open()
  return connection
}

async function openWanConnection(): Promise<TerminalHostConnection> {
  const binding = await terminalDataChannelResolver()
  if (!binding) {
    throw new TerminalSessionError("host_offline", "terminal WebRTC channel is unavailable")
  }
  let connection = wanConnections.get(binding.channel)
  if (!connection) {
    connection = new WanTerminalHostConnection(binding.channel, binding.clientId)
    wanConnections.set(binding.channel, connection)
  }
  await connection.open()
  return connection
}

function toWsBase(baseUrl: string): string {
  return baseUrl.replace(/^https:/, "wss:").replace(/^http:/, "ws:")
}

function isResponse(kind: TerminalFrameKind): boolean {
  return (
    kind === TerminalFrameKind.Ack ||
    kind === TerminalFrameKind.HostSnapshot ||
    kind === TerminalFrameKind.SessionSnapshot ||
    kind === TerminalFrameKind.Error
  )
}

function isStreamEvent(kind: TerminalFrameKind): boolean {
  return (
    kind === TerminalFrameKind.Stdout ||
    kind === TerminalFrameKind.Integration ||
    kind === TerminalFrameKind.Exit
  )
}

export function pickRemoteSpawn(): typeof RemoteTerminalSession.spawn | null {
  if (!isCapacitor() && !hasWebCompanionTarget()) return null
  return RemoteTerminalSession.spawn.bind(RemoteTerminalSession)
}
