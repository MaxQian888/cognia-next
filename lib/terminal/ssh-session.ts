"use client"

import { Channel, invoke } from "@tauri-apps/api/core"

import { BaseTerminalSession } from "./base-session"
import type { SshConnectRequest } from "./ssh-profiles"
import type { SessionInfo, TerminalEvent } from "./types"

type HostKeyStatus = "learned" | "verified"

interface SshSpawnResult {
  session: SessionInfo
  hostKeyStatus: HostKeyStatus
  hostKeyFingerprint: string
}

interface SeqEvent {
  seq: number
  event: TerminalEvent
}

export class SshTerminalSession extends BaseTerminalSession {
  readonly info: SessionInfo
  readonly profileId: string
  readonly hostKeyStatus: HostKeyStatus
  readonly hostKeyFingerprint: string

  private constructor(result: SshSpawnResult, profileId: string, channel: Channel<SeqEvent>) {
    super()
    this.info = result.session
    this.profileId = profileId
    this.hostKeyStatus = result.hostKeyStatus
    this.hostKeyFingerprint = result.hostKeyFingerprint
    channel.onmessage = ({ event }) => {
      switch (event.kind) {
        case "data":
          this.dispatchData(new Uint8Array(event.bytes))
          break
        case "integration":
          this.dispatchIntegration(event.event)
          break
        case "exit":
          this.handleExit(event.code ?? null)
          break
      }
    }
  }

  static async connect(req: SshConnectRequest): Promise<SshTerminalSession> {
    const onEvent = new Channel<SeqEvent>()
    const result = await invoke<SshSpawnResult>("ssh_terminal_spawn", { req, onEvent })
    return new SshTerminalSession(result, req.profileId, onEvent)
  }

  /**
   * Rebuild a handle on an SSH session the host already owns, after a renderer
   * reload dropped the JS side.
   *
   * The generic `terminal_reattach` command carries the stream because SSH and
   * local PTYs share one host-side session registry; what would otherwise be
   * lost is the SSH-specific identity, so the host key verdict and profile id
   * are restored from the listing rather than re-derived. A session listed
   * without them predates this field pair on the wire — reattaching still
   * works, the fingerprint is simply unknown until the next connect.
   */
  static async reattach(listed: SessionInfo, resumeFrom = 0): Promise<SshTerminalSession> {
    const onEvent = new Channel<SeqEvent>()
    // The host's answer is authoritative and fresher than the listing that got
    // us here, but a transport predating the host-key fields returns them
    // unset — fall back to the listing before giving up on them.
    const info = await invoke<SessionInfo>("terminal_reattach", {
      id: listed.id,
      onEvent,
      resumeFrom,
    })
    return new SshTerminalSession(
      {
        session: info,
        hostKeyStatus: info.sshHostKeyStatus ?? listed.sshHostKeyStatus ?? "learned",
        hostKeyFingerprint: info.sshHostKeyFingerprint ?? listed.sshHostKeyFingerprint ?? "",
      },
      info.profileId ?? listed.profileId ?? "",
      onEvent
    )
  }

  async write(data: Uint8Array | string): Promise<void> {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data
    await invoke("ssh_terminal_write", { id: this.info.id, data: Array.from(bytes) })
  }

  async resize(rows: number, cols: number): Promise<void> {
    await invoke("ssh_terminal_resize", {
      id: this.info.id,
      rows: Math.max(1, Math.floor(rows)),
      cols: Math.max(1, Math.floor(cols)),
    })
  }

  async detach(): Promise<void> {
    await invoke<void>("terminal_detach", { id: this.info.id })
  }

  async takeControl(): Promise<void> {
    await invoke<void>("terminal_take_control", { id: this.info.id })
    this.dispatchControlState({ role: "controller", controllerId: "local" })
  }

  async releaseControl(): Promise<void> {
    await invoke<void>("terminal_release_control", { id: this.info.id })
    this.dispatchControlState({ role: "viewer", controllerId: null, reason: "released" })
  }

  async kill(): Promise<void> {
    if (this.isExited) return
    await invoke("ssh_terminal_kill", { id: this.info.id })
  }
}
