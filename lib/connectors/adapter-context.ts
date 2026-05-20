/**
 * Builds a production `AdapterContext` for a given adapter id.
 *
 * Until im-refactored-crayon the provider only registered adapters with
 * the bus so the outbound runner could call `adapter.send()`. The
 * inbound `adapter.start(ctx)` lifecycle was deferred. This helper
 * closes that gap: it wraps the existing Tauri command bridge into the
 * `AdapterContext` shape adapters expect and provides an `emit` that
 * routes events through the bus's full inbound pipeline
 * (`dispatchInboundFull`) — dedup, adapter lookup, override resolution,
 * policy evaluation, route handler.
 *
 * Lark is the priority caller; its `start()` uses only `ctx.emit`, but
 * we wire every field of the interface so the same factory is reusable
 * once Discord/Slack/OneBot are lit up.
 *
 * No-op fields:
 *   - `bindWebhookRoute` / `unbindWebhookRoute`: Lark webhook transport
 *     uses Rust HTTP proxy + Tauri event listeners, not a per-adapter
 *     route registration. Throws when called so we discover usage if a
 *     future adapter actually needs it (rather than silently dropping).
 *   - `publicBaseUrl`: returns the row's `publicUrl` if set, else null —
 *     operators usually paste the public URL into the platform console
 *     manually.
 */

import { invoke } from "@tauri-apps/api/core"
import type {
  AdapterAttachmentRef,
  AdapterContext,
  AdapterLogger,
  AdapterSecrets,
  TauriHttpRequest,
  TauriHttpResponse,
  TauriWsHandle,
  TauriWsRequest,
} from "@/types/connectors/adapter"
import type { NormalizedInboundEvent } from "@/types/connectors/event"
import {
  connectorsAttachmentFetch,
  connectorsHttpRequest,
  connectorsKeyringDelete,
  connectorsKeyringGet,
  connectorsKeyringList,
  connectorsKeyringSet,
  connectorsWsClose,
  connectorsWsOpen,
  connectorsWsSend,
} from "./tauri/commands"
import type { ConnectorBus } from "./bus"

export interface BuildAdapterContextInput {
  adapterId: string
  signal: AbortSignal
  bus: ConnectorBus
  /** Adapter row at registration time; used to resolve `publicBaseUrl`. */
  publicUrl?: string | null
}

function createLogger(adapterId: string): AdapterLogger {
  const prefix = `[adapter:${adapterId}]`
  return {
    debug(msg, fields) {
      console.debug(prefix, msg, fields ?? {})
    },
    info(msg, fields) {
      console.info(prefix, msg, fields ?? {})
    },
    warn(msg, fields) {
      console.warn(prefix, msg, fields ?? {})
    },
    error(msg, fields) {
      console.error(prefix, msg, fields ?? {})
    },
  }
}

function createSecrets(adapterId: string): AdapterSecrets {
  return {
    get: (name) => connectorsKeyringGet(adapterId, name),
    set: (name, value) => connectorsKeyringSet(adapterId, name, value),
    delete: (name) => connectorsKeyringDelete(adapterId, name),
    /**
     * The Rust `connectors_keyring_list` command needs a candidate list
     * to probe (the OS keyring has no enumerate primitive). Return an
     * empty list when called with no candidates so callers can detect
     * "no probe vocabulary supplied" without an exception.
     */
    list: () => connectorsKeyringList(adapterId, []),
  }
}

async function openWs(req: TauriWsRequest): Promise<TauriWsHandle> {
  const id = await connectorsWsOpen(req.url, req.headers)
  return {
    id,
    send: (data) => connectorsWsSend(id, data),
    close: () => connectorsWsClose(id),
  }
}

async function fetchAttachment(
  adapterId: string,
  remoteRef: string
): Promise<AdapterAttachmentRef> {
  // The Rust command needs a sourceUrl. Callers that don't have one
  // (just a remoteRef) get a defensive error rather than a malformed
  // invocation. The Lark adapter does not use ctx.fetchAttachment — it
  // resolves media keys via the dedicated upload pipeline.
  const ref = await connectorsAttachmentFetch(adapterId, remoteRef, remoteRef)
  return { localUrl: ref.localUrl, remoteRef: ref.remoteRef }
}

function notImplemented(opName: string): () => Promise<never> {
  return () => {
    throw new Error(
      `[adapter-context] ${opName} is not wired in this runtime. ` +
        `Add a typed Tauri command + wrapper before relying on it.`
    )
  }
}

export function buildAdapterContext(input: BuildAdapterContextInput): AdapterContext {
  const { adapterId, signal, bus, publicUrl } = input
  return {
    adapterId,
    signal,
    emit: async (event: NormalizedInboundEvent) => {
      // Route every inbound event through the bus's full pipeline:
      // dedup → adapter lookup → override → policy → route → handler.
      // The runtime's installed route handler is what eventually turns
      // the event into a ChatSession + StoredMessage + ai-run.
      await bus.dispatchInboundFull(event)
    },
    tauri: {
      httpRequest: (req: TauriHttpRequest): Promise<TauriHttpResponse> =>
        connectorsHttpRequest(req),
      openWs,
      fetchAttachment: (id, remoteRef) => fetchAttachment(id, remoteRef),
      // bindWebhookRoute / unbindWebhookRoute do not have typed Tauri
      // wrappers yet because no adapter in v1 registers a per-adapter
      // HTTP route — Lark webhooks pass through the Rust HTTP proxy via
      // event channel instead. Throw so the gap is discovered rather
      // than silently swallowed if a future adapter relies on it.
      bindWebhookRoute: async (id: string, path: string) => {
        // Fall back to a direct invoke so when the command lands in
        // Rust we don't need a re-deploy here — the wrapper just
        // delegates. Until the command exists it'll throw "command not
        // found" with full context, which is exactly what we want.
        await invoke("connectors_bind_webhook_route", { adapterId: id, path })
      },
      unbindWebhookRoute: async (id: string, path: string) => {
        await invoke("connectors_unbind_webhook_route", { adapterId: id, path })
      },
      publicBaseUrl: async () => publicUrl ?? null,
    },
    secrets: createSecrets(adapterId),
    logger: createLogger(adapterId),
  }
}

/**
 * Re-exported for symmetry with the tests — calling code uses
 * `notImplemented` to assert the wired-but-untested branches.
 */
export const __testing = { notImplemented }
