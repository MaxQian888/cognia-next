"use client"

import { useEffect, useId, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { DownloadIcon, FileCode2Icon, RotateCcwIcon, UploadIcon } from "lucide-react"

import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockFilename,
  CodeBlockHeader,
  CodeBlockTitle,
} from "@/components/ai-elements/code-block"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import {
  parseStructuredConfig,
  serializeStructuredConfig,
  type StructuredConfigFormat,
} from "@/lib/config/structured-config"
import { downloadBlob } from "@/lib/files/download"

export interface StructuredConfigEditorProps<T> {
  value: T
  validate: (value: unknown) => T
  onApply: (value: T) => void | Promise<void>
  filename: string
  disabled?: boolean
}

export function StructuredConfigEditor<T>({
  value,
  validate,
  onApply,
  filename,
  disabled = false,
}: StructuredConfigEditorProps<T>) {
  const t = useTranslations("structuredConfig")
  const editorId = useId()
  const fileId = useId()
  const [format, setFormat] = useState<StructuredConfigFormat>("json")
  const [draft, setDraft] = useState(() => serializeStructuredConfig(value, "json"))
  const [lastValid, setLastValid] = useState(value)
  const [preview, setPreview] = useState(() => serializeStructuredConfig(value, "json"))
  const [error, setError] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [applying, setApplying] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (dirty) return
    // Reconcile an externally persisted configuration only while the editor has no local draft.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLastValid(value)
    setDraft(serializeStructuredConfig(value, format))
    setPreview(serializeStructuredConfig(value, format))
  }, [dirty, format, value])

  const parseDraft = (): T | null => {
    try {
      const parsed = parseStructuredConfig(draft, format, validate)
      setLastValid(parsed)
      setPreview(serializeStructuredConfig(parsed, format))
      setError(null)
      return parsed
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return null
    }
  }

  const changeFormat = (next: StructuredConfigFormat) => {
    if (next === format) return
    const parsed = parseDraft()
    if (!parsed) return
    setFormat(next)
    setDraft(serializeStructuredConfig(parsed, next))
    setPreview(serializeStructuredConfig(parsed, next))
    setDirty(false)
  }

  const apply = async () => {
    const parsed = parseDraft()
    if (!parsed) return
    setApplying(true)
    try {
      await onApply(parsed)
      setDirty(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setApplying(false)
    }
  }

  const reset = () => {
    const serialized = serializeStructuredConfig(value, format)
    setLastValid(value)
    setDraft(serialized)
    setPreview(serialized)
    setError(null)
    setDirty(false)
  }

  const importFile = async (file: File | undefined) => {
    if (!file) return
    const nextFormat: StructuredConfigFormat = /\.ya?ml$/i.test(file.name) ? "yaml" : "json"
    try {
      const source = await file.text()
      const parsed = parseStructuredConfig(source, nextFormat, validate)
      const normalized = serializeStructuredConfig(parsed, nextFormat)
      setFormat(nextFormat)
      setDraft(normalized)
      setPreview(normalized)
      setLastValid(parsed)
      setError(null)
      setDirty(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const extension = format === "json" ? "json" : "yaml"

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={format}
          onValueChange={(next) => changeFormat(next as StructuredConfigFormat)}
        >
          <SelectTrigger aria-label={t("format")} className="w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="json">{t("json")}</SelectItem>
              <SelectItem value="yaml">{t("yaml")}</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => fileInputRef.current?.click()}
        >
          <UploadIcon data-icon="inline-start" />
          {t("import")}
        </Button>
        <Input
          ref={fileInputRef}
          id={fileId}
          type="file"
          aria-label={t("import")}
          accept=".json,.yaml,.yml,application/json,application/yaml,text/yaml"
          className="sr-only"
          disabled={disabled}
          onChange={(event) => {
            void importFile(event.target.files?.[0])
            event.target.value = ""
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() =>
            downloadBlob(
              new Blob([serializeStructuredConfig(lastValid, format)], {
                type: format === "json" ? "application/json" : "application/yaml",
              }),
              `${filename}.${extension}`
            )
          }
        >
          <DownloadIcon data-icon="inline-start" />
          {t("download")}
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={!dirty} onClick={reset}>
          <RotateCcwIcon data-icon="inline-start" />
          {t("reset")}
        </Button>
      </div>

      <Field data-invalid={Boolean(error)}>
        <FieldLabel htmlFor={editorId}>{t("editorLabel")}</FieldLabel>
        <Textarea
          id={editorId}
          value={draft}
          disabled={disabled || applying}
          aria-invalid={Boolean(error)}
          spellCheck={false}
          className="min-h-80 resize-y font-mono text-xs"
          onChange={(event) => {
            setDraft(event.target.value)
            setDirty(true)
            setError(null)
          }}
        />
        <FieldDescription>{t("editorDescription")}</FieldDescription>
      </Field>

      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>{t("invalid")}</AlertTitle>
          <AlertDescription className="whitespace-pre-wrap break-words">{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={disabled || applying}
          onClick={parseDraft}
        >
          {t("validate")}
        </Button>
        <Button type="button" disabled={disabled || applying} onClick={() => void apply()}>
          {applying ? <Spinner data-icon="inline-start" /> : null}
          {t("apply")}
        </Button>
      </div>

      <CodeBlock code={preview} language={format} showLineNumbers>
        <CodeBlockHeader>
          <CodeBlockTitle>
            <FileCode2Icon className="size-4" />
            <CodeBlockFilename>{`${filename}.${extension}`}</CodeBlockFilename>
          </CodeBlockTitle>
          <CodeBlockActions>
            <CodeBlockCopyButton />
          </CodeBlockActions>
        </CodeBlockHeader>
      </CodeBlock>
    </div>
  )
}
