"use client"

/**
 * Context Workbench panel for the stored prompt templates.
 *
 * Registered imperatively (`ctx.contextPanels.register`) rather than through
 * `manifest.contextPanels`: that field resolves its renderer from a separate
 * `entry` module, which a `builtin://` plugin has no fetchable install path
 * for. Built-ins therefore always take this path.
 *
 * Clicking a template copies it. There is deliberately no "insert into the
 * composer" action — no plugin API can write to it today (the composer's input
 * lives in a component-local controller, not a store), and a button that
 * silently did nothing would be worse than one that does something smaller.
 */

import { useCallback, useEffect, useState } from "react"
import type { PluginContext } from "@/types/plugin"
import type { ContextPanelRenderProps } from "@/types/context-workbench"

const KEY_PREFIX = "template:"

export interface TemplateEntry {
  name: string
  body: string
}

export async function readAllTemplates(ctx: PluginContext): Promise<TemplateEntry[]> {
  const keys = (await ctx.storage?.keys?.()) ?? []
  const names = keys
    .filter((key) => key.startsWith(KEY_PREFIX))
    .map((key) => key.slice(KEY_PREFIX.length))
    .sort()
  const entries = await Promise.all(
    names.map(async (name) => ({
      name,
      body: (await ctx.storage?.get?.<string>(`${KEY_PREFIX}${name}`)) ?? "",
    }))
  )
  return entries
}

export function createTemplatesPanel(ctx: PluginContext) {
  return function TemplatesPanel({ active }: ContextPanelRenderProps) {
    const [templates, setTemplates] = useState<TemplateEntry[] | null>(null)

    // Storage is written by the slash commands, which can run while this panel
    // sits hidden behind `<Activity>`, so re-read on every re-activation rather
    // than once on mount.
    useEffect(() => {
      if (!active) return
      let cancelled = false
      void readAllTemplates(ctx).then((entries) => {
        if (!cancelled) setTemplates(entries)
      })
      return () => {
        cancelled = true
      }
    }, [active])

    const copy = useCallback(async (entry: TemplateEntry) => {
      try {
        await ctx.clipboard?.writeText?.(entry.body)
        ctx.ui?.showToast?.(`Copied template "${entry.name}".`, "success")
      } catch (error) {
        ctx.logger?.error?.("prompt-templates: copy failed", error)
        ctx.ui?.showToast?.(`Could not copy template "${entry.name}".`, "error")
      }
    }, [])

    if (templates === null) {
      return (
        <div className="flex h-full w-full min-w-0 max-w-full items-center justify-center overflow-x-hidden p-6 text-sm text-muted-foreground">
          Loading templates…
        </div>
      )
    }

    if (templates.length === 0) {
      return (
        <div className="flex h-full w-full min-w-0 max-w-full flex-col items-center justify-center gap-1 overflow-x-hidden p-6 text-center">
          <p className="text-sm font-medium">No prompt templates yet</p>
          <p className="text-xs text-muted-foreground">
            Save one with <code>/template-add &lt;name&gt; &lt;body&gt;</code>.
          </p>
        </div>
      )
    }

    return (
      <ul className="flex h-full w-full min-w-0 max-w-full flex-col gap-1 overflow-x-hidden overflow-y-auto p-2">
        {templates.map((entry) => (
          <li key={entry.name} className="min-w-0 max-w-full">
            <button
              type="button"
              onClick={() => void copy(entry)}
              className="flex w-full min-w-0 max-w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <span className="w-full truncate text-sm font-medium">{entry.name}</span>
              <span className="w-full truncate text-xs text-muted-foreground">{entry.body}</span>
            </button>
          </li>
        ))}
      </ul>
    )
  }
}
