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
 * Each adapter owns its `ConversationReference` shape, so this shared panel
 * keeps one compact target input but projects it into the fields that the
 * selected runtime actually reads.
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
import type { ConversationReference } from "@/types/connectors/event"

export interface SendTestMessageSectionProps {
  adapterId: string
  platform: PlatformKind
}

const REPLY_ONLY_PLATFORMS = new Set<PlatformKind>(["wechat-personal"])

interface ParsedTarget {
  kind?: string
  id: string
}

/**
 * Prefixes that select a conversation kind (e.g. `group:12345`). Anything
 * else containing a colon — Matrix room ids like `!abcd:matrix.org`, URLs,
 * platform ids with embedded colons — is a raw target id, NOT a kind prefix.
 */
const KNOWN_TARGET_KINDS = new Set([
  "group",
  "g",
  "single",
  "user",
  "private",
  "p",
  "c2c",
  "direct",
  "channel",
])

function parseTarget(raw: string): ParsedTarget {
  const trimmed = raw.trim()
  const separator = trimmed.indexOf(":")
  if (separator <= 0) return { id: trimmed }
  const kind = trimmed.slice(0, separator).trim().toLowerCase()
  if (!KNOWN_TARGET_KINDS.has(kind)) return { id: trimmed }
  const id = trimmed.slice(separator + 1).trim()
  return { kind, id }
}

function buildConversationRef(
  platform: PlatformKind,
  adapterId: string,
  rawTarget: string
): ConversationReference {
  const { kind, id } = parseTarget(rawTarget)
  const base: ConversationReference = { platform, adapterId }

  switch (platform) {
    case "discord":
    case "slack":
    case "lark":
      return { ...base, channelId: id }
    case "matrix":
      return { ...base, roomId: id }
    case "onebot": {
      const group = kind === "group" || kind === "g"
      return group
        ? { ...base, groupId: id, chatKey: `g:${id}` }
        : { ...base, userId: id, chatKey: `p:${id}` }
    }
    case "dingtalk": {
      const group = kind === "group"
      return group
        ? { ...base, conversationType: "2", openConversationId: id }
        : { ...base, conversationType: "1", userId: id }
    }
    case "wecom": {
      const chatType = kind === "group" ? "group" : "single"
      return { ...base, chatId: id, chatType, ...(chatType === "single" ? { userId: id } : {}) }
    }
    case "wechat-oa":
      return { ...base, openId: id }
    case "qq-official": {
      const scene =
        kind === "group" || kind === "c2c" || kind === "direct" || kind === "channel"
          ? kind
          : "channel"
      return { ...base, scene, sceneId: id }
    }
    case "telegram":
    default:
      return { ...base, chatId: id, channelId: id }
  }
}

export function SendTestMessageSection({ adapterId, platform }: SendTestMessageSectionProps) {
  const t = useTranslations("settings.connections.sendTest")
  const [chatId, setChatId] = useState("")
  const [body, setBody] = useState(t("defaultBody"))
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState<OutboundResult | null>(null)
  const desktop = isTauri()
  const sendUnsupported = REPLY_ONLY_PLATFORMS.has(platform)

  const handleSend = async () => {
    if (!chatId.trim() || sendUnsupported) return
    setSending(true)
    setResult(null)
    try {
      const trimmedBody = body.trim() || t("defaultBody")
      const conversationRef = buildConversationRef(platform, adapterId, chatId)
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

  const disabled = !desktop || sending || !chatId.trim() || sendUnsupported

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
            placeholder={t(`targetPlaceholder.${platform}`)}
            disabled={sending}
            className="h-9 font-mono text-xs"
            data-testid="send-test-chat-id"
          />
          <p className="text-[10px] text-muted-foreground">{t(`chatIdHelp.${platform}`)}</p>
          {sendUnsupported && (
            <p
              className="text-[10px] text-amber-700 dark:text-amber-400"
              data-testid="send-test-unsupported"
            >
              {t("unsupportedReplyOnly")}
            </p>
          )}
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
