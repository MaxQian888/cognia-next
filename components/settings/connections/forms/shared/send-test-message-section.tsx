"use client"

/**
 * SendTestMessageSection — Task 3.1.
 *
 * After an adapter is configured the operator needs an "is this end-to-end
 * working?" affordance. The existing `AdapterWhoamiPanel` already verifies
 * credentials (Task 3.1's probe leg); this component fills in the other
 * half: drive a real outbound send through the bus and surface the result.
 *
 * Reuse:
 *   - `getBus().sendOutbound(adapterId, req)` is the single entry point —
 *     identical to what the outbound runner uses, so any success here
 *     proves the entire serialize → Tauri http → platform pipeline works.
 *   - `newIdempotencyKey()` is the same helper enqueueOutbound uses.
 *   - i18n keys live in `settings.connections.sendTest.*` shared across
 *     every platform.
 *
 * Per-platform `chat_id` placeholder text is the only varying bit — every
 * platform's `ConversationReference` shape lets us drop the target id in
 * under a stable key (`chatId` for telegram/lark/onebot, `channelId` for
 * discord/slack). The adapter parses whichever it understands; passing
 * both keys is safe.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { CheckCircle2Icon, LoaderIcon, SendIcon, XCircleIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { getBus } from "@/lib/connectors/bus"
import { newIdempotencyKey } from "@/types/connectors/outbound"
import { isTauri } from "@/lib/tauri"
import type { PlatformKind } from "@/types/connectors/platform-kind"
import type { OutboundResult } from "@/types/connectors/outbound"

export interface SendTestMessageSectionProps {
  adapterId: string
  platform: PlatformKind
}

const PLATFORM_PLACEHOLDER: Partial<Record<PlatformKind, string>> = {
  telegram: "123456789",
  discord: "1234567890123456789",
  slack: "C0123ABC456",
  lark: "oc_xxxxxxxxxxxxxxxx",
  onebot: "987654321",
}

function placeholderFor(platform: PlatformKind): string {
  return PLATFORM_PLACEHOLDER[platform] ?? "chat-id"
}

export function SendTestMessageSection({ adapterId, platform }: SendTestMessageSectionProps) {
  const t = useTranslations("settings.connections.sendTest")
  const [chatId, setChatId] = useState("")
  const [body, setBody] = useState(t("defaultBody"))
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState<OutboundResult | null>(null)
  const desktop = isTauri()

  const handleSend = async () => {
    if (!chatId.trim()) return
    setSending(true)
    setResult(null)
    try {
      const trimmedBody = body.trim() || t("defaultBody")
      // Pass both `chatId` and `channelId` so any adapter can pick the
      // key it understands — the bus doesn't inspect this object beyond
      // `platform` + `adapterId`, the adapter is what reads the rest.
      const conversationRef = {
        platform,
        adapterId,
        chatId: chatId.trim(),
        channelId: chatId.trim(),
      }
      const sendResult = await getBus().sendOutbound(adapterId, {
        conversationRef,
        segments: [{ type: "text", text: trimmedBody }],
        metadata: { idempotencyKey: newIdempotencyKey() },
      })
      setResult(sendResult)
    } catch (err) {
      setResult({
        ok: false,
        error: {
          code: "unexpected",
          message: err instanceof Error ? err.message : String(err),
          retryable: false,
        },
      })
    } finally {
      setSending(false)
    }
  }

  const disabled = !desktop || sending || !chatId.trim()

  return (
    <Card data-testid="send-test-message-section">
      <CardHeader className="pb-2 pt-3">
        <CardTitle className="text-sm font-medium">{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">{t("intro")}</p>

        <div className="space-y-1.5">
          <Label htmlFor="send-test-chat-id" className="text-xs">
            {t("chatIdLabel")}
          </Label>
          <Input
            id="send-test-chat-id"
            value={chatId}
            onChange={(e) => setChatId(e.target.value)}
            placeholder={placeholderFor(platform)}
            disabled={sending}
            className="h-9 font-mono text-xs"
            data-testid="send-test-chat-id"
          />
          <p className="text-[10px] text-muted-foreground">{t(`chatIdHelp.${platform}`)}</p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="send-test-body" className="text-xs">
            {t("bodyLabel")}
          </Label>
          <Input
            id="send-test-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            disabled={sending}
            className="h-9 text-xs"
            data-testid="send-test-body"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            onClick={() => void handleSend()}
            disabled={disabled}
            data-testid="send-test-button"
          >
            {sending ? (
              <LoaderIcon className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <SendIcon className="mr-1.5 h-3.5 w-3.5" />
            )}
            {t("sendButton")}
          </Button>
          {!desktop && (
            <span className="text-[10px] text-amber-700 dark:text-amber-400">
              {t("desktopOnly")}
            </span>
          )}
        </div>

        {result && (
          <div
            className={`flex items-start gap-2 rounded-md px-3 py-2 text-xs ${
              result.ok
                ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300"
                : "bg-destructive/10 text-destructive"
            }`}
            role="status"
            data-testid="send-test-result"
          >
            {result.ok ? (
              <CheckCircle2Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            ) : (
              <XCircleIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            )}
            <span className="break-all">
              {result.ok
                ? t("sentSuccess", {
                    messageId: result.platformMessageId ?? "—",
                  })
                : t("sentError", {
                    code: result.error?.code ?? "unknown",
                    message: result.error?.message ?? "",
                  })}
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
