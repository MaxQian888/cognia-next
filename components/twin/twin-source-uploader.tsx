"use client"

/**
 * Minimal source uploader — paste text + pick format. Phase 7 ships the
 * paste path only; the file-picker path lands when the importers in
 * `lib/twin/importers/` come online.
 */

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { createTwinSource } from "@/lib/db/twin-sources"
import { detectSourceFormat, listSupportedFormats } from "@/lib/twin/ingest"
import type { TwinSourceFormat } from "@/types/twin"

const FORMATS: TwinSourceFormat[] = listSupportedFormats() as TwinSourceFormat[]

async function sha256(text: string): Promise<string> {
  const enc = new TextEncoder()
  const bytes = enc.encode(text)
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

export interface TwinSourceUploaderProps {
  twinId: string
  onUploaded?: () => void
}

export function TwinSourceUploader({ twinId, onUploaded }: TwinSourceUploaderProps) {
  const [title, setTitle] = useState("")
  const [content, setContent] = useState("")
  const [format, setFormat] = useState<TwinSourceFormat>("markdown")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async () => {
    if (!content.trim()) {
      setError("Paste some content before saving")
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const fingerprint = await sha256(content)
      const inferred = title.trim() ? null : detectSourceFormat(title)
      await createTwinSource({
        twinId,
        kind:
          format === "code" || format === "git-repo"
            ? "code"
            : format === "mbox" || format === "eml"
              ? "email"
              : format.endsWith("-export")
                ? "chat"
                : "document",
        format: (inferred as TwinSourceFormat | undefined) ?? format,
        source: title.trim() || "manual paste",
        title: title.trim() || `Pasted ${format} (${new Date().toLocaleString()})`,
        bytes: content.length,
        fingerprint,
        redacted: false,
        status: "pending",
      })
      setContent("")
      setTitle("")
      onUploaded?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="flex flex-1 flex-col gap-1">
          <Label htmlFor="twin-source-title">Title (optional)</Label>
          <Input
            id="twin-source-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. onboarding-notes.md"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="twin-source-format">Format</Label>
          <select
            id="twin-source-format"
            className="border-border bg-background h-9 rounded border px-2 text-sm"
            value={format}
            onChange={(e) => setFormat(e.target.value as TwinSourceFormat)}
          >
            {FORMATS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor="twin-source-content">Content</Label>
        <Textarea
          id="twin-source-content"
          rows={8}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Paste markdown, code, or exported chat content here…"
        />
      </div>

      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}

      <div className="flex justify-end">
        <Button onClick={handleSubmit} disabled={submitting}>
          {submitting ? "Saving…" : "Save source"}
        </Button>
      </div>
    </Card>
  )
}
