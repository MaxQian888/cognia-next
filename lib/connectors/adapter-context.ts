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
  /**
   * The credential names this adapter declares (`credentialsRef.accounts`).
   * The OS keyring has no enumerate primitive, so `secrets.list()` can only
   * report which of a supplied candidate set exists — without this it has
   * nothing to probe and can only ever answer "none".
   */
  credentialAccounts?: readonly string[]
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

function createSecrets(adapterId: string, accounts: readonly string[]): AdapterSecrets {
  return {
    get: (name) => connectorsKeyringGet(adapterId, name),
    set: (name, value) => connectorsKeyringSet(adapterId, name, value),
    delete: (name) => connectorsKeyringDelete(adapterId, name),
    /**
     * Which of this adapter's declared credentials are actually stored.
     *
     * The Rust `connectors_keyring_list` command probes a candidate list
     * because the OS keyring has no enumerate primitive. This used to pass
     * `[]`, so it could never report anything — a probe with no vocabulary
     * always answers "none", which is indistinguishable from "nothing is
     * stored". The row's `credentialsRef.accounts` IS that vocabulary.
     */
    list: () => connectorsKeyringList(adapterId, [...accounts]),
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
  // The cache stores ciphertext only, so there is no path to hand back — the
  // handle identifies the entry and `readAttachment` returns the bytes.
  return {
    localUrl: `cognia-attachment:${ref.cacheKey}`,
    remoteRef: ref.remoteRef,
    cacheKey: ref.cacheKey,
  }
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
  const { adapterId, signal, bus, publicUrl, credentialAccounts } = input
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
      // bindWebhookRoute / unbindWebhookRoute have no typed Tauri wrapper —
      // no adapter in v1 registers a per-adapter HTTP route (Lark webhooks
      // pass through the Rust HTTP proxy via the event channel instead), and
      // the underlying `connectors_bind_webhook_route` Rust command does not
      // exist. Route them through `notImplemented` so a future adapter that
      // relies on this gets a clear, self-documenting error at the call site
      // rather than an opaque "command not found" from a phantom `invoke`.
      bindWebhookRoute: notImplemented("bindWebhookRoute"),
      unbindWebhookRoute: notImplemented("unbindWebhookRoute"),
      publicBaseUrl: async () => publicUrl ?? null,
    },
    secrets: createSecrets(adapterId, credentialAccounts ?? []),
    logger: createLogger(adapterId),
  }
}

/**
 * Re-exported for symmetry with the tests — calling code uses
 * `notImplemented` to assert the wired-but-untested branches.
 */
export const __testing = { notImplemented }
