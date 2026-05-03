"use client"

/**
 * AddProviderPopover - Quick add popover for built-in providers
 * Shows a 2×4 grid of preset providers; clicking one triggers the callback.
 */

import { useState } from "react"
import { Plus, Wand2, Check } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

const QUICK_ADD_PROVIDERS = [
  { id: "openai", name: "OpenAI", icon: "🤖", desc: "GPT-4o, GPT-4 Turbo" },
  { id: "anthropic", name: "Anthropic", icon: "🧠", desc: "Claude 3.5, Claude 3" },
  { id: "google", name: "Google", icon: "🔍", desc: "Gemini Pro, Gemini Ultra" },
  { id: "deepseek", name: "DeepSeek", icon: "🌊", desc: "DeepSeek V3, Coder" },
  { id: "groq", name: "Groq", icon: "⚡", desc: "Fast inference engine" },
  { id: "mistral", name: "Mistral", icon: "🌀", desc: "Mistral Large, Medium" },
  { id: "openrouter", name: "OpenRouter", icon: "🔀", desc: "Multi-provider gateway" },
  { id: "ollama", name: "Ollama", icon: "🦙", desc: "Local model runner" },
]

interface AddProviderPopoverProps {
  children: React.ReactNode
  onSelectProvider: (providerId: string) => void
  onCustomProvider: () => void
  onOpenWizard: () => void
  /** Provider IDs that are already configured — shown with a checkmark */
  configuredProviderIds?: string[]
}

export function AddProviderPopover({
  children,
  onSelectProvider,
  onCustomProvider,
  onOpenWizard,
  configuredProviderIds = [],
}: AddProviderPopoverProps) {
  const t = useTranslations("providers")
  const [open, setOpen] = useState(false)

  const handleSelectProvider = (providerId: string) => {
    onSelectProvider(providerId)
    setOpen(false)
  }

  const handleCustomProvider = () => {
    onCustomProvider()
    setOpen(false)
  }

  const handleOpenWizard = () => {
    onOpenWizard()
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        <div className="p-3 border-b">
          <p className="text-sm font-semibold">{t("quickAdd.title")}</p>
        </div>

        <div className="p-3">
          <div className="grid grid-cols-2 gap-2">
            {QUICK_ADD_PROVIDERS.map((provider) => {
              const isConfigured = configuredProviderIds.includes(provider.id)
              return (
                <button
                  key={provider.id}
                  onClick={() => handleSelectProvider(provider.id)}
                  className={`flex items-center gap-2 rounded-lg border p-2 hover:bg-muted/50 cursor-pointer text-left transition-colors ${isConfigured ? "border-primary/30 bg-primary/5" : ""}`}
                >
                  <span className="text-lg shrink-0">{provider.icon}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium leading-none">{provider.name}</p>
                    <p className="text-xs text-muted-foreground mt-0.5 truncate">{provider.desc}</p>
                  </div>
                  {isConfigured && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
                </button>
              )
            })}
          </div>
        </div>

        <div className="border-t p-3 flex flex-col gap-2">
          <Button
            variant="outline"
            className="w-full justify-start gap-2"
            onClick={handleCustomProvider}
          >
            <Plus className="h-4 w-4" />
            {t("quickAdd.customProvider")}
          </Button>
          <button
            onClick={handleOpenWizard}
            className="flex items-center gap-2 px-2 py-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <Wand2 className="h-4 w-4" />
            {t("quickAdd.wizard")}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

export default AddProviderPopover
