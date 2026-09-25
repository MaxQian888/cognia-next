"use client"

/**
 * ADR-0194 §8 — the desktop chat copilot's capture permission, edited apart
 * from the agent-facing surfaces. The Rust gate (`evaluate_chat_copilot`)
 * reads `off` and `perCall` as "ask every time" and `whitelist` as "capture
 * the apps on this policy's own list without asking". A generic TierSelect
 * would label the default "Off" while the host still asks, so this card only
 * offers the two behaviours the gate actually has.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import type { AutomationSettings, SurfacePolicy, Whitelist } from "@/lib/automation/client"
import { BadgeListEditor } from "./access-rules-tab"

type CaptureMode = "ask" | "allowListed"

function modeOf(policy: SurfacePolicy | undefined): CaptureMode {
  return policy?.tier === "whitelist" ? "allowListed" : "ask"
}

function ownList(policy: SurfacePolicy | undefined): Whitelist {
  return policy?.whitelist ?? { processNames: [], windowTitlePatterns: [] }
}

export function ChatCopilotCaptureCard({
  settings,
  onChange,
  saving,
}: {
  settings: AutomationSettings
  onChange: (next: AutomationSettings) => void | Promise<void>
  saving: boolean
}) {
  const t = useTranslations("automation.permissions.chatCopilot")
  const [draft, setDraft] = useState("")
  // Settings written by a build that predates the surface come back from the
  // host already defaulted; the fallback only guards a hand-edited payload.
  const policy = settings.perSurface.chatCopilot
  const mode = modeOf(policy)
  const list = ownList(policy)

  function write(next: SurfacePolicy) {
    void onChange({
      ...settings,
      perSurface: { ...settings.perSurface, chatCopilot: next },
    })
  }

  function addEntry() {
    const value = draft.trim()
    if (!value) return
    setDraft("")
    if (list.processNames.includes(value)) return
    write({
      tier: policy?.tier ?? "off",
      whitelist: { ...list, processNames: [...list.processNames, value] },
    })
  }

  function removeEntry(entry: string) {
    write({
      tier: policy?.tier ?? "off",
      whitelist: { ...list, processNames: list.processNames.filter((name) => name !== entry) },
    })
  }

  return (
    <Card data-testid="chat-copilot-capture-card">
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <fieldset className="space-y-2" disabled={saving}>
          <legend className="font-medium">{t("modeLabel")}</legend>
          <RadioGroup
            value={mode}
            onValueChange={(value) =>
              write({
                ...(policy?.whitelist ? { whitelist: policy.whitelist } : {}),
                tier: value === "allowListed" ? "whitelist" : "off",
              })
            }
          >
            <div className="flex items-start gap-2">
              <RadioGroupItem value="ask" id="chat-copilot-mode-ask" className="mt-0.5" />
              <div className="space-y-0.5">
                <Label htmlFor="chat-copilot-mode-ask">{t("modeAsk")}</Label>
                <p className="text-xs text-muted-foreground">{t("modeAskHint")}</p>
              </div>
            </div>
            <div className="flex items-start gap-2">
              <RadioGroupItem
                value="allowListed"
                id="chat-copilot-mode-allow-listed"
                className="mt-0.5"
              />
              <div className="space-y-0.5">
                <Label htmlFor="chat-copilot-mode-allow-listed">{t("modeAllowListed")}</Label>
                <p className="text-xs text-muted-foreground">{t("modeAllowListedHint")}</p>
              </div>
            </div>
          </RadioGroup>
        </fieldset>

        {mode === "allowListed" && (
          <BadgeListEditor
            label={t("processNames")}
            description={t("processNamesHint")}
            placeholder={t("processPlaceholder")}
            addLabel={t("add")}
            removeAriaFor={(entry) => t("removeEntryAria", { entry })}
            emptyLabel={t("empty")}
            value={draft}
            onValueChange={setDraft}
            onAdd={addEntry}
            entries={list.processNames}
            onRemove={removeEntry}
            testId="chat-copilot-process-names"
          />
        )}

        <p className="text-xs text-muted-foreground">{t("permissionNote")}</p>
      </CardContent>
    </Card>
  )
}
