"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { updateAdapterConfigSection } from "@/lib/db/adapter-instances"
import { getDb } from "@/lib/db/schema"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type {
  AdapterInstanceRow,
  ImHostCapabilityId,
  MediaModelPolicy,
} from "@/lib/db/connector-types"

const HOST_CAPABILITIES: ImHostCapabilityId[] = [
  "computer_use",
  "ocr",
  "goal_driving",
  "schedule_tools",
]

function selectors(row?: AdapterInstanceRow) {
  return row?.builtInSkillCeiling?.join(", ") ?? ""
}

export function AdapterPermissions({ adapterId }: { adapterId: string }) {
  const row = useLiveQuery(
    // `async` so both branches share one `Promise<AdapterInstanceRow | undefined>`.
    // The ternary's mixed `Promise.resolve(undefined)` / `PromiseExtended<...>`
    // union defeated `useLiveQuery`'s unwrapping, so `row` came back as the
    // promise itself.
    async () =>
      typeof window === "undefined" ? undefined : getDb().adapterInstances.get(adapterId),
    [adapterId]
  )
  return (
    <AdapterPermissionsDraft
      key={`${adapterId}:${row?.updatedAt ?? "loading"}`}
      adapterId={adapterId}
      row={row}
    />
  )
}

function AdapterPermissionsDraft({
  adapterId,
  row,
}: {
  adapterId: string
  row?: AdapterInstanceRow
}) {
  const t = useTranslations("settings.connections.permissionsEditor")
  const [skills, setSkills] = useState(() => selectors(row))
  const [host, setHost] = useState<ImHostCapabilityId[]>(
    () => row?.hostCapabilityCeiling ?? HOST_CAPABILITIES
  )
  const [hitl, setHitl] = useState(() => row?.requireHitlForWrites ?? true)
  // Bot-wide media policy. Hard-coded to `local_extract_only` by all eleven
  // create dialogs and editable nowhere, so `allow_cloud_binary` was
  // unreachable at this scope even though the resolver reads it as the base
  // every conversation grant sits on top of.
  const [mediaPolicy, setMediaPolicy] = useState<MediaModelPolicy>(
    () => row?.mediaModelPolicy ?? "local_extract_only"
  )

  const save = async () => {
    if (typeof window !== "undefined" && !window.confirm(t("confirmImpact"))) return
    const parsed = skills
      .split(/[\s,;]+/)
      .map((item) => item.trim())
      .filter(Boolean)
    await updateAdapterConfigSection(
      adapterId,
      "permissions",
      {
        builtInSkillCeiling: skills.trim() ? parsed : undefined,
        hostCapabilityCeiling: host.length === HOST_CAPABILITIES.length ? undefined : host,
        requireHitlForWrites: hitl,
        mediaModelPolicy: mediaPolicy,
      },
      "settings.adapter.permissions"
    )
  }

  return (
    <Card data-testid="adapter-permissions">
      <CardHeader className="pb-2 pt-3">
        <CardTitle className="text-sm font-medium">{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor="adapter-skill-ceiling">{t("builtInSkills")}</Label>
          <Input
            id="adapter-skill-ceiling"
            value={skills}
            onChange={(event) => setSkills(event.target.value)}
            placeholder={t("skillPlaceholder")}
          />
          <p className="text-xs text-muted-foreground">{t("skillHelp")}</p>
        </div>
        <div className="space-y-3">
          <Label>{t("hostCapabilities")}</Label>
          {HOST_CAPABILITIES.map((capability) => (
            <div key={capability} className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm">{t(`host.${capability}`)}</p>
                {capability !== "ocr" && (
                  <p className="text-xs text-muted-foreground">{t("conversationGrantRequired")}</p>
                )}
              </div>
              <Switch
                checked={host.includes(capability)}
                onCheckedChange={(checked) =>
                  setHost((current) =>
                    checked
                      ? Array.from(new Set([...current, capability]))
                      : current.filter((item) => item !== capability)
                  )
                }
              />
            </div>
          ))}
        </div>
        {/* Bot-WIDE, and therefore the blunter of the two controls: a
         * conversation grant is provider-scoped, revocable and expiring, and
         * this is none of those. The warning is not decoration. */}
        <div className="space-y-2">
          <Label htmlFor="adapter-media-policy">{t("mediaPolicy")}</Label>
          <Select
            value={mediaPolicy}
            onValueChange={(next) => setMediaPolicy(next as MediaModelPolicy)}
          >
            <SelectTrigger id="adapter-media-policy" data-testid="adapter-media-policy">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="local_extract_only">{t("mediaPolicyLocal")}</SelectItem>
              <SelectItem value="allow_cloud_binary">{t("mediaPolicyCloud")}</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{t("mediaPolicyHelp")}</p>
          {mediaPolicy === "allow_cloud_binary" && (
            <p className="text-xs text-destructive" data-testid="adapter-media-policy-warning">
              {t("mediaPolicyWarning")}
            </p>
          )}
        </div>
        <div className="flex items-center justify-between gap-3">
          <div>
            <Label>{t("hitl")}</Label>
            <p className="text-xs text-muted-foreground">{t("hitlHelp")}</p>
          </div>
          <Switch checked={hitl} onCheckedChange={setHitl} />
        </div>
        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            onClick={() => {
              setSkills(selectors(row))
              setHost(row?.hostCapabilityCeiling ?? HOST_CAPABILITIES)
              setHitl(row?.requireHitlForWrites ?? true)
            }}
          >
            {t("cancel")}
          </Button>
          <Button onClick={() => void save()}>{t("save")}</Button>
        </div>
      </CardContent>
    </Card>
  )
}
