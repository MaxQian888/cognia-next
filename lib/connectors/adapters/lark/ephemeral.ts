import type { OutboundError, OutboundRequest, OutboundResult } from "@/types/connectors/outbound"

type EphemeralRequest = (method: "GET" | "POST", path: string, body?: unknown) => Promise<unknown>

interface LarkEphemeralOptions {
  /** Authenticated bot request; must not auto-retry ambiguous POST failures. */
  request: EphemeralRequest
  classifyError: (error: unknown) => OutboundError
  sendAsUser?: boolean
}

const invalid = (message: string): OutboundResult => ({
  ok: false,
  error: { code: "validation", message, retryable: false },
})
const unknownDelivery = (message: string): OutboundResult => ({
  ok: false,
  error: { code: "delivery_unknown", message, retryable: false },
})

/** Dedicated lifecycle: ephemeral cards cannot use normal message fallbacks or UUID retry. */
export function createLarkEphemeral(options: LarkEphemeralOptions) {
  return {
    async send(req: OutboundRequest, prepareCard: () => Promise<unknown>): Promise<OutboundResult> {
      const ref = req.deliveryTarget?.conversationRef ?? req.conversationRef
      const address = req.deliveryTarget?.address
      const recipient = req.metadata.larkEphemeral?.recipientOpenId
      const chatId = ref.channelId
      if (
        options.sendAsUser ||
        ref.platform !== "lark" ||
        req.conversationRef.platform !== "lark" ||
        ref.adapterId !== req.conversationRef.adapterId ||
        typeof recipient !== "string" ||
        !/^ou_[A-Za-z0-9_-]+$/.test(recipient) ||
        typeof chatId !== "string" ||
        !/^oc_[A-Za-z0-9_-]+$/.test(chatId) ||
        req.editTargetMessageId ||
        req.replyTo ||
        req.threadId ||
        ref.threadId ||
        ref.threadTs ||
        ref.threadRootMessageId ||
        address?.topicId ||
        (address &&
          (address.scopeKind !== "group" ||
            address.platform !== "lark" ||
            address.containerId !== chatId ||
            address.adapterId !== ref.adapterId)) ||
        req.metadata.failoverFromAdapterId ||
        req.metadata.balancedFromAdapterId ||
        req.segments.length !== 1 ||
        !["card", "a2ui"].includes(req.segments[0].type)
      ) {
        return invalid(
          "Lark ephemeral delivery requires one card, an ordinary group, a recipient open_id, and the original bot identity"
        )
      }
      let card: unknown
      try {
        const info = (await options.request(
          "GET",
          `/im/v1/chats/${encodeURIComponent(chatId)}`
        )) as {
          data?: { chat_mode?: string; chat_type?: string }
        }
        if (info?.data?.chat_mode !== "group") {
          return invalid("Lark ephemeral cards require verified ordinary group chat information")
        }
        // Media uploads and serialization occur only after validating identity
        // and chat mode. Their failures cannot mean a card was already sent.
        card = await prepareCard()
        if (!card || typeof card !== "object" || Array.isArray(card)) {
          return invalid("Lark ephemeral card content must be a card JSON or template object")
        }
      } catch (error) {
        const classified = options.classifyError(error)
        return {
          ok: false,
          error: {
            ...classified,
            ...(["network", "platform_5xx"].includes(classified.code)
              ? { code: "preparation_failed" }
              : {}),
          },
        }
      }
      try {
        const response = (await options.request("POST", "/ephemeral/v1/send", {
          chat_id: chatId,
          open_id: recipient,
          msg_type: "interactive",
          card,
        })) as { data?: { message_id?: string } }
        if (typeof response?.data?.message_id !== "string" || !response.data.message_id) {
          return unknownDelivery(
            "Lark ephemeral send returned no message_id; reconcile before retrying"
          )
        }
        return { ok: true, platformMessageId: response.data.message_id }
      } catch (error) {
        const classified = options.classifyError(error)
        if (classified.code === "network" || classified.code === "platform_5xx") {
          return unknownDelivery(classified.message)
        }
        return { ok: false, error: classified }
      }
    },
    async delete(messageId: string): Promise<void> {
      if (!/^om_[A-Za-z0-9_-]+$/.test(messageId))
        throw new Error("Invalid Lark ephemeral message_id")
      await options.request("POST", "/ephemeral/v1/delete", { message_id: messageId })
    },
  }
}
