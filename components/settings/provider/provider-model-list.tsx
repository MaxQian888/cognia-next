"use client"

/**
 * The provider-grouped model list, rendered once instead of three times.
 *
 * The Built-in Runtime default-model picker, the goal judge picker and the
 * routing alias combobox were three files carrying the same forty lines: a
 * `CommandInput`, provider groups separated by rules, a check in a fixed
 * gutter, and a mono model id. They drifted in the ways copies drift, so one of
 * them had a trailing "clear" row and another had it under a different label
 * while the third had none.
 *
 * Deliberately NOT folded onto `components/shared/model-select.tsx`, which
 * looks like the same control and is not. That one reads
 * `lib/ai/model-options`, the CHAT universe, with display names, context
 * windows and capability glyphs. These three read
 * `@cognia/provider-routing/model-option-source`, which is the ROUTER's
 * candidate universe, and whose own header says a picker and the router must
 * never collect differently ("a model a user can select but the router cannot
 * see is a routing bug wearing a UI costume"). Merging the two would quietly
 * decouple these pickers from the router they configure.
 *
 * So: one body, two universes, and the universe stays the caller's choice.
 */

import { CheckIcon } from "lucide-react"

import {
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command"
import { cn } from "@/lib/utils"
import type { ModelOptionGroup } from "@cognia/provider-routing/model-option-source"

/** A trailing row that is not a model: "use the chat model", "clear". */
export interface ProviderModelListFooter {
  label: string
  /** cmdk needs a filterable value, and it must not collide with a model id. */
  value: string
  disabled?: boolean
  onSelect: () => void
}

export interface ProviderModelListProps {
  groups: ModelOptionGroup[]
  activeProviderId?: string
  activeModelId?: string
  searchPlaceholder: string
  emptyLabel: string
  onSelect: (providerId: string, modelId: string) => void
  footer?: ProviderModelListFooter
}

export function ProviderModelList({
  groups,
  activeProviderId,
  activeModelId,
  searchPlaceholder,
  emptyLabel,
  onSelect,
  footer,
}: ProviderModelListProps) {
  return (
    <>
      <CommandInput placeholder={searchPlaceholder} />
      <CommandList>
        {groups.length === 0 ? (
          <CommandEmpty>{emptyLabel}</CommandEmpty>
        ) : (
          <>
            {groups.map((group, index) => (
              <div key={group.providerId}>
                {index > 0 ? <CommandSeparator /> : null}
                <CommandGroup heading={group.providerName}>
                  {group.models.map((modelId) => {
                    const isActive =
                      modelId === activeModelId && group.providerId === activeProviderId
                    return (
                      <CommandItem
                        key={`${group.providerId}:${modelId}`}
                        // Both parts, so typing either the provider or the
                        // model id finds the row.
                        value={`${group.providerId} ${modelId}`}
                        onSelect={() => onSelect(group.providerId, modelId)}
                        data-testid="provider-model-option"
                        data-active={isActive || undefined}
                      >
                        {/* The gutter is reserved on every row rather than
                            mounted only on the active one, so the ids do not
                            step sideways when the selection moves. */}
                        <CheckIcon
                          className={cn("mr-2 size-4", isActive ? "opacity-100" : "opacity-0")}
                        />
                        <span className="font-mono text-xs">{modelId}</span>
                      </CommandItem>
                    )
                  })}
                </CommandGroup>
              </div>
            ))}
            {footer ? (
              <>
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem
                    value={footer.value}
                    onSelect={footer.onSelect}
                    disabled={footer.disabled}
                    data-testid="provider-model-footer"
                  >
                    <span className="text-xs text-muted-foreground">{footer.label}</span>
                  </CommandItem>
                </CommandGroup>
              </>
            ) : null}
          </>
        )}
      </CommandList>
    </>
  )
}
