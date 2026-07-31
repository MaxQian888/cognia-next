"use client"

import { MessageSquareTextIcon } from "lucide-react"

import { MatchHighlight } from "@/components/chat/completion/match-highlight"
import { CommandGroup, CommandItem } from "@/components/ui/command"
import { Spinner } from "@/components/ui/spinner"
import type { ChatSearchResult } from "@/lib/chat/search/engine"

interface ChatHistorySearchResultsProps {
  query: string
  results: readonly ChatSearchResult[]
  loading: boolean
  error: Error | null
  coverageIncomplete: boolean
  heading: string
  loadingLabel: string
  errorLabel: string
  coverageLabel: string
  onSelect: (result: ChatSearchResult) => void
}

/**
 * Shared desktop/mobile projection of indexed message hits inside cmdk.
 *
 * Search execution stays in the shared hook; this component only renders the
 * engine's already-ranked snippets and exact highlight offsets.
 */
export function ChatHistorySearchResults({
  query,
  results,
  loading,
  error,
  coverageIncomplete,
  heading,
  loadingLabel,
  errorLabel,
  coverageLabel,
  onSelect,
}: ChatHistorySearchResultsProps) {
  if (!query.trim() || (!loading && !error && !coverageIncomplete && results.length === 0)) {
    return null
  }

  const feedbackValue = `history ${query}`

  return (
    <CommandGroup heading={heading}>
      {loading ? (
        <CommandItem disabled value={`${feedbackValue} loading`}>
          <Spinner className="size-4" aria-hidden />
          <span>{loadingLabel}</span>
        </CommandItem>
      ) : null}
      {error ? (
        <CommandItem disabled value={`${feedbackValue} error`}>
          <span className="text-muted-foreground">{errorLabel}</span>
        </CommandItem>
      ) : null}
      {results.map((result) => (
        <CommandItem
          key={result.messageId}
          value={`${result.sessionTitle} ${result.snippet.text}`}
          onSelect={() => onSelect(result)}
          className="items-start"
        >
          <MessageSquareTextIcon className="mt-0.5 size-4" />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{result.sessionTitle}</span>
            <MatchHighlight
              text={result.snippet.text}
              positions={result.snippet.positions}
              className="line-clamp-2 text-xs text-muted-foreground"
              markClassName="text-foreground"
            />
          </span>
        </CommandItem>
      ))}
      {coverageIncomplete && !loading ? (
        <CommandItem disabled value={`${feedbackValue} incomplete`}>
          <span className="text-xs text-muted-foreground">{coverageLabel}</span>
        </CommandItem>
      ) : null}
    </CommandGroup>
  )
}
