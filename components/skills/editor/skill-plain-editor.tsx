"use client"

import { Textarea } from "@/components/ui/textarea"

interface Props {
  value: string
  /** Displayed in the status bar by the workspace; unused here. */
  language: string
  onChange: (value: string) => void
}

/**
 * Plain-textarea fallback for the editor workspace on mobile, where Monaco's
 * virtual-keyboard handling is unusable. Same value/onChange contract as
 * `SkillMonacoEditor` so the workspace can swap them by viewport.
 */
export function SkillPlainEditor({ value, onChange }: Props) {
  return (
    <Textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="min-h-0 flex-1 resize-none rounded-none border-0 font-mono text-sm focus-visible:ring-0"
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      data-testid="skill-plain-editor"
    />
  )
}
