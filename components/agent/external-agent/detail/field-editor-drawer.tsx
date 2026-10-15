"use client"

import { useId, useRef, useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"

import { ResponsiveFormDialog } from "@/components/shared/responsive-form-dialog"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"

export interface FieldEditorDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  children: ReactNode
  onSave: () => Promise<boolean>
  saveDisabled?: boolean
  testid: string
}

export function FieldEditorDrawer({
  open,
  onOpenChange,
  title,
  description,
  children,
  onSave,
  saveDisabled,
  testid,
}: FieldEditorDrawerProps) {
  const tCommon = useTranslations("common")
  const t = useTranslations("externalAgent")
  const formId = useId()
  const savingRef = useRef(false)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)

  const changeOpen = (next: boolean) => {
    if (savingRef.current) return
    setFailed(false)
    onOpenChange(next)
  }

  const save = async () => {
    if (saveDisabled || savingRef.current) return
    savingRef.current = true
    setSaving(true)
    setFailed(false)
    try {
      if (await onSave()) onOpenChange(false)
    } catch {
      setFailed(true)
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  return (
    <ResponsiveFormDialog
      open={open}
      onOpenChange={changeOpen}
      title={title}
      description={description}
      testid={testid}
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={saving}
            onClick={() => changeOpen(false)}
          >
            {tCommon("cancel")}
          </Button>
          <Button
            type="submit"
            form={formId}
            className="min-h-11"
            disabled={saving || saveDisabled}
            aria-busy={saving}
          >
            {saving ? <Spinner /> : null}
            {tCommon(saving ? "saving" : "save")}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="space-y-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            !event.defaultPrevented &&
            !event.nativeEvent.isComposing &&
            event.target instanceof HTMLInputElement &&
            !["checkbox", "radio", "button", "submit", "reset", "file"].includes(event.target.type)
          ) {
            event.preventDefault()
            void save()
          }
        }}
      >
        <fieldset disabled={saving} className="min-w-0 space-y-4">
          {children}
        </fieldset>
        {failed ? (
          <p role="alert" className="text-sm text-destructive">
            {t("setConfigOptionFailed")}
          </p>
        ) : null}
      </form>
    </ResponsiveFormDialog>
  )
}
