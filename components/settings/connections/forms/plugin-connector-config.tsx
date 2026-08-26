"use client"

/**
 * Configuration dialog for a connector kind contributed by a plugin.
 *
 * `plugin-connector-registry.ts` has always let a plugin own a `PlatformKind`
 * and run the full supervisor path — started, stopped, hot-reconciled,
 * health-checked and audited exactly like a built-in. What it could not do was
 * be configured. The picker's kind list was eleven hardcoded literals, so a
 * contributed kind never appeared in it, `isConfigurableKind` answered false,
 * and the Configure button on an existing row was a no-op. The registry even
 * validates `configSchema` on the grounds that "a settings form can be
 * generated from it" — and the generator was in the unreachable-components
 * baseline.
 *
 * There is deliberately no per-plugin dialog: the schema IS the form. What the
 * host adds around it is the part a plugin should not have to reimplement —
 * the display name, the enable switch, the keyring-backed credentials, and the
 * default trigger policy — so a contributed bot behaves like every other bot
 * rather than like a plugin's private settings page.
 */

import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  ConnectorHostNotice,
  useConnectorControlReach,
} from "@/components/connectors/connector-host-notice"
import { useAdapterCredentials } from "@/hooks/connectors/use-adapter-credentials"
import { createAdapterInstance, updateAdapterInstance } from "@/lib/db/adapter-instances"
import { emitCredentialsRotated } from "@/lib/connectors/credentials-events"
import {
  getPluginConnector,
  pluginConnectorSecretFields,
} from "@/lib/connectors/plugin-connector-registry"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { defaultTriggerPolicyFor, type TriggerPolicy } from "@/types/connectors/policy"

import { AdapterForm, type JsonSchema } from "./adapter-form"

export interface PluginConnectorConfigDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The contributed kind being configured. */
  kind: string
  onCreated?: (id: string) => void
  row: AdapterInstanceRow | null
}

export function PluginConnectorConfigDialog({
  open,
  onOpenChange,
  kind,
  row,
  onCreated,
}: PluginConnectorConfigDialogProps) {
  const t = useTranslations("settings.connections.pluginConnector")
  const isNew = row === null
  const reach = useConnectorControlReach()
  const registration = useMemo(() => getPluginConnector(kind), [kind])

  const [displayName, setDisplayName] = useState("")
  const [saving, setSaving] = useState(false)

  // Reseed once per opened row rather than on every render: the dialogs are
  // mounted together and only toggled by `open`, so without this the name would
  // carry over from the last bot the operator edited — and re-running it on
  // every render would fight the operator's typing.
  const seededFor = useRef<string | null>(null)
  useEffect(() => {
    if (!open) {
      seededFor.current = null
      return
    }
    const seed = row?.id ?? `new:${kind}`
    if (seededFor.current === seed) return
    seededFor.current = seed
    setDisplayName(row?.displayName ?? registration?.def.displayName ?? kind)
  }, [open, row, kind, registration])

  const schema = (registration?.def.configSchema ?? {}) as JsonSchema
  const secretFields = useMemo(
    () => pluginConnectorSecretFields(registration?.def.configSchema),
    [registration]
  )
  const credentials = useAdapterCredentials({
    adapterId: row?.id ?? null,
    accounts: secretFields,
    enabled: open,
  })

  const save = async (values: Record<string, unknown>) => {
    const name = displayName.trim()
    if (!name) {
      toast.error(t("nameRequired"))
      return
    }
    const missing = credentials.missingRequired(secretFields)
    if (missing.length > 0) {
      toast.error(t("credentialsRequired", { fields: missing.join(", ") }))
      return
    }
    setSaving(true)
    try {
      if (row) {
        await updateAdapterInstance(row.id, { displayName: name, settings: values })
        await credentials.persist(row.id)
        if (credentials.dirty) emitCredentialsRotated(row.id)
      } else {
        const created = await createAdapterInstance({
          type: kind,
          displayName: name,
          enabled: true,
          // The contribution's own policy wins; the host default is the floor
          // so a plugin that declares none still gets a bot that can answer.
          trigger:
            (registration?.def.defaultTrigger as TriggerPolicy | undefined) ??
            defaultTriggerPolicyFor(kind),
          transportMode: (registration?.def.transportModes?.[0] ??
            "gateway") as AdapterInstanceRow["transportMode"],
          settings: values,
          mediaModelPolicy: "local_extract_only",
          defaultMode: "auto",
        })
        await credentials.persist(created.id)
        onCreated?.(created.id)
      }
      toast.success(t("saved"))
      onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isNew
              ? t("createTitle", { name: registration?.def.displayName ?? kind })
              : t("editTitle", { name: registration?.def.displayName ?? kind })}
          </DialogTitle>
        </DialogHeader>

        {/* A row whose plugin was disabled keeps its settings and stays
         * editable-looking; saying the implementation is gone beats a form
         * that silently writes to a kind nothing can start. */}
        {!registration ? (
          <p className="text-xs text-destructive" data-testid="plugin-connector-unregistered">
            {t("unregistered", { kind })}
          </p>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="plugin-connector-name">{t("nameLabel")}</Label>
              <Input
                id="plugin-connector-name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                disabled={saving}
                data-testid="plugin-connector-name"
              />
              <p className="text-xs text-muted-foreground">
                {t("providedBy", { plugin: registration.pluginId })}
              </p>
            </div>

            <AdapterForm
              schema={schema}
              initialValues={row?.settings ?? {}}
              secretFields={secretFields}
              credentials={credentials}
              onSubmit={save}
              onCancel={() => onOpenChange(false)}
              submitLabel={isNew ? t("create") : t("save")}
              // The read has to land before save: until it does the form does
              // not know its own credential baseline. Same rule the built-in
              // dialogs follow.
              disabled={saving || credentials.loading}
            />

            <ConnectorHostNotice reach={reach} />
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
