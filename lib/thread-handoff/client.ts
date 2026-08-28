"use client"

import type { CanonicalSession } from "@cognia/agent-config-types/canonical-session"
import type {
  ThreadHandoffPreflight,
  ThreadHandoffRole,
  ThreadHandoffTicket,
} from "@cognia/agent-config-types/thread-handoff"

import { transport } from "@/lib/tauri"

import type { AcceptedThreadHandoffProof, SourceCommitProof } from "./service"

export type ThreadHandoffCall = (name: string, args: Record<string, unknown>) => Promise<unknown>

export interface ThreadHandoffClientOptions {
  call?: ThreadHandoffCall
}

export class ThreadHandoffClient {
  private readonly call: ThreadHandoffCall

  constructor(options: ThreadHandoffClientOptions = {}) {
    this.call = options.call ?? ((name, args) => transport.call(name, args))
  }

  offer(ticket: ThreadHandoffTicket): Promise<ThreadHandoffTicket> {
    return this.call("thread_handoff_offer", { ticket }) as Promise<ThreadHandoffTicket>
  }

  preflight(ticket: ThreadHandoffTicket): Promise<ThreadHandoffPreflight> {
    return this.call("thread_handoff_preflight", { ticket }) as Promise<ThreadHandoffPreflight>
  }

  accept(
    ticket: ThreadHandoffTicket,
    envelope: CanonicalSession,
    adminLease: string
  ): Promise<{ ticket: ThreadHandoffTicket; proof: AcceptedThreadHandoffProof }> {
    return this.call("thread_handoff_accept", {
      ticket,
      envelope,
      adminLease,
    }) as Promise<{ ticket: ThreadHandoffTicket; proof: AcceptedThreadHandoffProof }>
  }

  commitSource(
    ticketId: string,
    acceptedProof: AcceptedThreadHandoffProof,
    adminLease: string
  ): Promise<{ ticket: ThreadHandoffTicket; proof: SourceCommitProof }> {
    return this.call("thread_handoff_commit", {
      ticketId,
      role: "source",
      acceptedProof,
      adminLease,
    }) as Promise<{ ticket: ThreadHandoffTicket; proof: SourceCommitProof }>
  }

  commitTarget(
    ticketId: string,
    sourceCommitProof: SourceCommitProof,
    adminLease: string
  ): Promise<{ ticket: ThreadHandoffTicket; proof: { state: "committed" } }> {
    return this.call("thread_handoff_commit", {
      ticketId,
      role: "target",
      sourceCommitProof,
      adminLease,
    }) as Promise<{ ticket: ThreadHandoffTicket; proof: { state: "committed" } }>
  }

  abort(
    ticketId: string,
    role: ThreadHandoffRole,
    peerDisposition?: "not-accepted" | "deleted"
  ): Promise<ThreadHandoffTicket> {
    return this.call("thread_handoff_abort", {
      ticketId,
      role,
      ...(peerDisposition ? { peerDisposition } : {}),
    }) as Promise<ThreadHandoffTicket>
  }

  status(ticketId: string, role: ThreadHandoffRole): Promise<ThreadHandoffTicket | null> {
    return this.call("thread_handoff_status", {
      ticketId,
      role,
    }) as Promise<ThreadHandoffTicket | null>
  }
}
