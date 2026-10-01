"use client"

import { useId, useState } from "react"
import { useTranslations } from "next-intl"
import { CopyIcon, ExternalLinkIcon } from "lucide-react"
import { toast } from "sonner"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { openUrl } from "@/lib/native/opener"
import { writeClipboardText } from "@/lib/tauri/clipboard"
import { writeText as writeMobileClipboardText } from "@/lib/capacitor/clipboard"
import { detectPlatform } from "@/lib/platform/detect"

const BASE_SCOPES = [
  "im:message.p2p_msg:readonly",
  "im:message.group_at_msg:readonly",
  "im:message:send_as_bot",
]

// Scope identifiers verified against the linked Feishu API contracts on 2026-10-01.
const FEATURES = [
  { id: "cards", scopes: ["cardkit:card:write"] },
  { id: "attachments", scopes: ["im:resource"] },
  { id: "history", scopes: ["im:message:readonly", "im:message.group_msg"] },
  { id: "allMessages", scopes: ["im:message.group_msg"] },
  { id: "botMentions", scopes: ["im:message.group_at_msg.include_bot:readonly"] },
  { id: "botMessages", scopes: ["im:message.group_msg.include_bot:read"] },
  {
    id: "menus",
    scopes: ["im:chat:readonly", "im:chat.tabs:write_only", "im:chat.menu_tree:write_only"],
  },
] as const

type Feature = (typeof FEATURES)[number]["id"]

interface LarkSetupGuideProps {
  appId: string
  transport: "long-connection" | "webhook"
  isNew: boolean
  credentialsVerified: boolean
  botIdentityKnown: boolean
}

export function LarkSetupGuide({
  appId,
  transport,
  isNew,
  credentialsVerified,
  botIdentityKnown,
}: LarkSetupGuideProps) {
  const t = useTranslations("settings.connections.lark.setupGuide")
  const id = useId()
  const [selected, setSelected] = useState<Feature[]>(["cards", "attachments"])
  const [copying, setCopying] = useState(false)
  const scopes = Array.from(
    new Set([
      ...BASE_SCOPES,
      ...FEATURES.filter((feature) => selected.includes(feature.id)).flatMap((feature) => [
        ...feature.scopes,
      ]),
    ])
  )
  const trimmedAppId = appId.trim()
  const consoleUrl = /^cli_[a-zA-Z0-9]+$/.test(trimmedAppId)
    ? `https://open.feishu.cn/app/${trimmedAppId}`
    : "https://open.feishu.cn/app"

  async function openLink(url: string) {
    try {
      await openUrl(url)
    } catch {
      toast.error(t("openFailed"))
    }
  }

  async function copyScopes() {
    setCopying(true)
    try {
      const platform = detectPlatform()
      const text = scopes.join("\n")
      // Preserve explicit mobile failures; the generic writer can resolve without a backend.
      if (platform === "mobile") {
        const result = await writeMobileClipboardText(text)
        if (result.kind !== "ok") {
          if (!navigator.clipboard?.writeText) {
            toast.error(t("copyFailed"))
            return
          }
          await navigator.clipboard.writeText(text)
        }
      } else {
        if (platform === "web" && !navigator.clipboard?.writeText) {
          toast.error(t("copyFailed"))
          return
        }
        await writeClipboardText(text)
      }
      toast.success(t("copied"))
    } catch {
      toast.error(t("copyFailed"))
    } finally {
      setCopying(false)
    }
  }

  return (
    <div className="min-w-0 space-y-3">
      <div className="flex flex-wrap gap-2">
        <Badge variant="outline">
          {t(credentialsVerified ? "credentialsVerified" : "credentialsUnverified")}
        </Badge>
        <Badge variant="outline">{t(botIdentityKnown ? "identityKnown" : "identityUnknown")}</Badge>
      </div>
      <p className="text-xs text-muted-foreground">{t("evidenceBoundary")}</p>
      <Button type="button" size="sm" variant="outline" onClick={() => void openLink(consoleUrl)}>
        <ExternalLinkIcon className="size-3.5" aria-hidden />
        {t("openConsole")}
      </Button>
      <Accordion type="single" collapsible defaultValue={isNew ? "app" : undefined}>
        <AccordionItem value="app">
          <AccordionTrigger>{t("app.title")}</AccordionTrigger>
          <AccordionContent className="space-y-2 text-xs text-muted-foreground">
            <p>{t("app.create")}</p>
            <p>{t("app.credentials")}</p>
            <p>{t("app.host")}</p>
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="permissions">
          <AccordionTrigger>{t("permissions.title")}</AccordionTrigger>
          <AccordionContent className="space-y-3">
            <p className="text-xs text-muted-foreground">{t("permissions.base")}</p>
            <ul className="space-y-1 text-xs">
              {BASE_SCOPES.map((scope) => (
                <li key={scope}>
                  <code className="break-all">{scope}</code>
                </li>
              ))}
            </ul>
            <fieldset className="space-y-2">
              <legend className="mb-2 text-xs font-medium">{t("permissions.optional")}</legend>
              <p className="text-xs text-muted-foreground">{t("permissions.selectionHelp")}</p>
              {FEATURES.map((feature) => (
                <div key={feature.id} className="flex items-start gap-2">
                  <Checkbox
                    id={`${id}-${feature.id}`}
                    checked={selected.includes(feature.id)}
                    onCheckedChange={(checked) =>
                      setSelected((current) =>
                        checked === true
                          ? [...current, feature.id]
                          : current.filter((item) => item !== feature.id)
                      )
                    }
                    aria-describedby={`${id}-${feature.id}-help`}
                    className="mt-0.5"
                  />
                  <div className="min-w-0 space-y-1">
                    <Label htmlFor={`${id}-${feature.id}`} className="text-xs">
                      {t(`features.${feature.id}.title`)}
                    </Label>
                    <p id={`${id}-${feature.id}-help`} className="text-xs text-muted-foreground">
                      {t(`features.${feature.id}.help`)}
                    </p>
                  </div>
                </div>
              ))}
            </fieldset>
            <pre
              aria-label={t("permissions.selected")}
              className="max-h-40 overflow-auto rounded-md bg-muted p-2 text-xs whitespace-pre-wrap break-all"
            >
              {scopes.join("\n")}
            </pre>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={copying}
                onClick={() => void copyScopes()}
              >
                <CopyIcon className="size-3.5" aria-hidden />
                {t("copyScopes")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() =>
                  void openLink(
                    "https://open.feishu.cn/document/server-docs/im-v1/message/events/receive"
                  )
                }
              >
                <ExternalLinkIcon className="size-3.5" aria-hidden />
                {t("permissions.docs")}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t("permissions.apply")}</p>
            <p className="text-xs text-muted-foreground">{t("permissions.oauth")}</p>
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="delivery">
          <AccordionTrigger>{t("delivery.title")}</AccordionTrigger>
          <AccordionContent className="space-y-3 text-xs text-muted-foreground">
            <ol className="list-decimal space-y-2 pl-5">
              <li>
                {t(
                  transport === "long-connection" ? "delivery.longStart" : "delivery.webhookStart"
                )}
              </li>
              <li>
                {t(
                  transport === "long-connection"
                    ? "delivery.longConsole"
                    : "delivery.webhookConsole"
                )}
              </li>
              <li>
                {t("delivery.event")}{" "}
                <code className="break-all">
                  {
                    /* i18n-exempt: Lark event identifier, identical in every language */ "im.message.receive_v1"
                  }
                </code>
              </li>
              <li>
                {t("delivery.callback")}{" "}
                <code className="break-all">
                  {
                    /* i18n-exempt: Lark event identifier, identical in every language */ "card.action.trigger"
                  }
                </code>
              </li>
            </ol>
            <p>
              {t(
                transport === "long-connection"
                  ? "delivery.longKeepRunning"
                  : "delivery.webhookSecurity"
              )}
            </p>
            <p>{t("delivery.menus")}</p>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() =>
                void openLink(
                  "https://open.feishu.cn/document/feishu-cards/card-callback-communication"
                )
              }
            >
              <ExternalLinkIcon className="size-3.5" aria-hidden />
              {t("delivery.docs")}
            </Button>
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="publish">
          <AccordionTrigger>{t("publish.title")}</AccordionTrigger>
          <AccordionContent className="space-y-2 text-xs text-muted-foreground">
            <p>{t("publish.version")}</p>
            <p>{t("publish.availability")}</p>
            <p>{t("publish.group")}</p>
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="verify">
          <AccordionTrigger>{t("verify.title")}</AccordionTrigger>
          <AccordionContent className="space-y-3 text-xs text-muted-foreground">
            <p>{t("verify.configure")}</p>
            <ol className="list-decimal space-y-2 pl-5">
              <li>{t("verify.private")}</li>
              <li>{t("verify.mention")}</li>
              <li>{t("verify.card")}</li>
              <li>{t("verify.optional")}</li>
            </ol>
            <p>{t("verify.troubleshoot")}</p>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  )
}
