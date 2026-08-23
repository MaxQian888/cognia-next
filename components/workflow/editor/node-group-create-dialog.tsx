"use client"

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Textarea } from "@/components/ui/textarea"
import type { EditorStore } from "@/lib/workflow/editor/store"
import {
  createNodeGroupFromSelection,
  inferNodeGroupSelection,
} from "@/lib/workflow/node-groups/authoring"

export function NodeGroupCreateDialog({
  open,
  onOpenChange,
  store,
  selectedNodeIds,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  store: EditorStore
  selectedNodeIds: string[]
}) {
  const t = useTranslations("workflows.editor.nodeGroupCreate")
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [version, setVersion] = useState("1.0.0")
  const [scope, setScope] = useState<"personal" | "workspace" | "portable-bundle">("personal")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const workflow = store.getState().toWorkflow()
  const inferred = useMemo(() => {
    if (!open) return null
    try {
      return inferNodeGroupSelection(workflow, selectedNodeIds)
    } catch (caught) {
      return caught instanceof Error ? caught : new Error(String(caught))
    }
  }, [open, selectedNodeIds, workflow])

  const submit = async () => {
    if (!name.trim() || inferred instanceof Error || !inferred) return
    setBusy(true)
    setError(null)
    try {
      const definition = await createNodeGroupFromSelection({
        workflow,
        selectedNodeIds,
        id: name,
        name,
        description,
        version,
        scope,
      })
      if (scope === "portable-bundle") {
        const url = URL.createObjectURL(
          new Blob([JSON.stringify(definition, null, 2)], { type: "application/json" })
        )
        const anchor = document.createElement("a")
        anchor.href = url
        anchor.download = `${definition.id}-${definition.version}.node-group.json`
        anchor.click()
        URL.revokeObjectURL(url)
      }
      onOpenChange(false)
      setName("")
      setDescription("")
      setVersion("1.0.0")
      setScope("personal")
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="node-group-create-dialog">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="node-group-name">{t("name")}</Label>
            <Input
              id="node-group-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="node-group-description">{t("details")}</Label>
            <Textarea
              id="node-group-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor="node-group-version">{t("version")}</Label>
              <Input
                id="node-group-version"
                value={version}
                onChange={(event) => setVersion(event.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="node-group-scope">{t("scope")}</Label>
              <NativeSelect
                id="node-group-scope"
                value={scope}
                onChange={(event) => setScope(event.target.value as typeof scope)}
              >
                <NativeSelectOption value="personal">{t("scopes.personal")}</NativeSelectOption>
                <NativeSelectOption value="workspace">{t("scopes.workspace")}</NativeSelectOption>
                <NativeSelectOption value="portable-bundle">
                  {t("scopes.portableBundle")}
                </NativeSelectOption>
              </NativeSelect>
            </div>
          </div>
          {inferred instanceof Error ? (
            <p className="text-sm text-destructive">{inferred.message}</p>
          ) : inferred ? (
            <div
              className="space-y-2 rounded border p-2 text-xs"
              data-testid="node-group-interface"
            >
              <p className="font-medium">{t("confirmInterface")}</p>
              <p>{t("nodeCount", { count: inferred.nodes.length })}</p>
              <div>
                <p className="text-muted-foreground">{t("inputs")}</p>
                {inferred.interface.inputs.length ? (
                  inferred.interface.inputs.map((port) => (
                    <p key={port.id}>
                      {port.label} · {port.required ? t("required") : t("optional")}
                    </p>
                  ))
                ) : (
                  <p>{t("none")}</p>
                )}
              </div>
              <div>
                <p className="text-muted-foreground">{t("outputs")}</p>
                {inferred.interface.outputs.length ? (
                  inferred.interface.outputs.map((port) => <p key={port.id}>{port.label}</p>)
                ) : (
                  <p>{t("none")}</p>
                )}
              </div>
            </div>
          ) : null}
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            {t("cancel")}
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={busy || !name.trim() || inferred instanceof Error}
          >
            {t("create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
