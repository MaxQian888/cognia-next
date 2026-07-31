/**
 * Discord Interactions Webhook transport.
 *
 * IMPORTANT: Discord's Interactions Endpoint URL delivers ONLY interactions
 * (slash commands, message components, modal submits) — it NEVER delivers
 * message events (`MESSAGE_CREATE` / DMs). Those require the Gateway with the
 * MESSAGE_CONTENT intent. So this transport is interaction-only; a webhook-mode
 * bot answers buttons / slash commands but cannot receive chat messages.
 *
 * The Rust webhook route (`axum_app.rs::discord_webhook_handler`) has already
 * verified the Ed25519 signature and answered the PING handshake / deferred ACK
 * in the HTTP response body. It emits each non-PING interaction to
 * `connectors://webhook/<adapterId>`; this transport projects that payload into
 * the ConnectorBus callback pipeline. The assistant's reply then flows out as a
 * normal channel message via REST (no gateway required).
 *
 * Modal-open is gateway-only: answering with a type-9 MODAL requires the modal
 * definition from the renderer's Dexie bindings, which the Rust route cannot
 * build synchronously — so in webhook mode a modal-open button degrades to a
 * plain callback.
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import { getBus } from "@/lib/connectors/bus"
import { parseDiscordInteraction, type DiscordDispatch } from "./parse"

export interface WebhookTransportHandle {
  stop: () => void
}

export interface WebhookTransportOptions {
  adapterId: string
  /** Bot's own user id (from /users/@me); may be "" if the probe failed. */
  selfId: string
  signal: AbortSignal
}

/**
 * Subscribe to `connectors://webhook/<adapterId>` and forward each verified
 * Discord interaction into `dispatchConnectorCallback`.
 */
export async function startWebhookTransport(
  opts: WebhookTransportOptions
): Promise<WebhookTransportHandle> {
  const { adapterId, selfId } = opts

  const unlisten: UnlistenFn = await listen<unknown>(
    `connectors://webhook/${adapterId}`,
    (event) => {
      const interaction = event.payload
      // Rust only emits interaction objects here; ignore anything else.
      if (!interaction || typeof interaction !== "object") return
      const dispatch: DiscordDispatch = { t: "INTERACTION_CREATE", op: 0, d: interaction }
      const callback = parseDiscordInteraction(adapterId, selfId, dispatch)
      if (!callback) return
      void getBus()
        .dispatchConnectorCallback(callback)
        .catch(() => {
          // A failed callback dispatch must not tear down the subscription.
        })
    }
  )

  const onAbort = () => unlisten()
  opts.signal.addEventListener("abort", onAbort)

  return {
    stop: () => {
      opts.signal.removeEventListener("abort", onAbort)
      unlisten()
    },
  }
}
