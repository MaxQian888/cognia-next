"use client"

/**
 * The per-installation settings a definition's `configSchema` asks for.
 *
 * The form is `AdapterForm`, not a new one. It is the settings surface's
 * JSON-Schema generator, it already routes `writeOnly` and
 * `format: "password"` fields to keyring-backed inputs, and its own header
 * notes that it was rescued from the unreachable baseline by acquiring a
 * second caller. This is the third.
 *
 * `secretFields` is deliberately EMPTY here, and that is a statement rather
 * than an omission. A Bot never stores a secret in `config`: credentials are
 * slots bound to an integration account or a connector adapter, and the broker
 * resolves the real value at call time. A schema that declared `writeOnly`
 * would therefore be asking for something this table refuses to hold, and
 * `AdapterForm` renders such a field disabled without a controller rather than
 * silently falling back to a plain input that would write it into the row.
 *
 * Values are seeded through `resolveBotConfig`, the same resolver the runtime
 * uses, so what the form opens with is what a run would receive. Deriving
 * defaults here instead would give the form and the runtime two answers.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"

import { AdapterForm, type JsonSchema } from "@/components/settings/connections/forms/adapter-form"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import {
  useBotLifecycleActions,
  useBotLifecycleReadiness,
} from "@/hooks/bots/use-bot-lifecycle-actions"
import type { BotConsoleRow } from "@/lib/bot/console/bot-rows"
import { defaultsFromConfigSchema, resolveBotConfig } from "@/lib/bot/config/resolve-effective"

export function BotConfigSection({ row }: { row: BotConsoleRow }) {
  const t = useTranslations("bots")
  const readiness = useBotLifecycleReadiness()
  const actions = useBotLifecycleActions()
  const [authority, setAuthority] = useState<{
    id: string
    unattended: boolean
    automatic: boolean
  } | null>(null)
  const storedUnattended = row.policyGrant?.maxAuthority === "bypassPermissions"
  const storedAutomatic =
    row.policyGrant?.maxAutonomy === "autopilot" &&
    row.policyGrant?.requireApprovalForWrites === false
  const selection =
    authority?.id === row.id
      ? authority
      : { id: row.id, unattended: storedUnattended, automatic: storedAutomatic }
  const authorityChanged =
    selection.unattended !== storedUnattended || selection.automatic !== storedAutomatic

  const initialValues = useMemo(
    () =>
      resolveBotConfig({
        installation: row.config,
        definitionDefaults: defaultsFromConfigSchema(row.configSchema),
      }).values,
    [row.config, row.configSchema]
  )

  if (row.orphaned) {
    return (
      <Empty className="border-none py-4">
        <EmptyHeader>
          <EmptyTitle className="text-sm">{t("config.orphanTitle")}</EmptyTitle>
          <EmptyDescription className="text-xs">{t("config.orphanBody")}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  const busy = actions.pending.has(`config:${row.id}`)

  return (
    <div className="flex flex-col gap-2" data-testid="bot-config">
      <fieldset
        className="mb-3 flex flex-col gap-3 rounded-md border p-3"
        disabled={!readiness.can || busy}
      >
        <legend className="px-1 text-sm font-medium">{t("config.authorityTitle")}</legend>
        <p className="text-xs text-muted-foreground">{t("config.authorityHint")}</p>
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor={`bot-unattended-${row.id}`}>{t("config.allowUnattended")}</Label>
          <Switch
            id={`bot-unattended-${row.id}`}
            checked={selection.unattended}
            onCheckedChange={(unattended) => setAuthority({ ...selection, unattended })}
            disabled={!readiness.can || busy}
          />
        </div>
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor={`bot-automatic-${row.id}`}>{t("config.allowAutomaticPublication")}</Label>
          <Switch
            id={`bot-automatic-${row.id}`}
            checked={selection.automatic}
            onCheckedChange={(automatic) => setAuthority({ ...selection, automatic })}
            disabled={!readiness.can || busy}
          />
        </div>
      </fieldset>
      <AdapterForm
        key={row.id}
        // The schema is `Record<string, unknown>` on the definition because the
        // manifest type does not depend on the form's subset. Narrowing here
        // rather than at the type keeps the manifest free of a UI dependency.
        schema={(row.configSchema ?? { type: "object", properties: {} }) as JsonSchema}
        initialValues={initialValues}
        disabled={!readiness.can || busy}
        submitLabel={t("config.save")}
        // The form's contract is `void`, and `saveConfig` answers whether it
        // landed. Awaited rather than dropped so the form's own submitting
        // state covers the write instead of ending a frame into it.
        onSubmit={async (values) => {
          const config = row.configSchema ? values : row.config
          if (authorityChanged) {
            const saved = await actions.saveConfig(row.id, config, {
              maxAuthority: selection.unattended ? "bypassPermissions" : "acceptEdits",
              maxAutonomy: selection.unattended || selection.automatic ? "autopilot" : "confirm",
              requireApprovalForWrites: !selection.automatic,
            })
            if (saved) setAuthority(null)
          } else await actions.saveConfig(row.id, config)
        }}
      />
      {!readiness.can ? (
        // Rendered and disabled rather than hidden: an absent form says "this
        // Bot has no settings", which is a different answer from "not from
        // here".
        <p
          className="text-[11px] leading-snug text-muted-foreground"
          data-testid="bot-config-blocked"
        >
          {t(`write.reason.${readiness.availability.reason}`)}
        </p>
      ) : null}
    </div>
  )
}
