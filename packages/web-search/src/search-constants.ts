/**
 * Search constants
 */

/**
 * Search source definition
 */
export interface SearchSource {
  id: string
  name: string
  icon: string
}

/**
 * Available search sources for research
 */
export const SEARCH_SOURCES: SearchSource[] = [
  { id: "google", name: "Google", icon: "🔍" },
  { id: "brave", name: "Brave", icon: "🦁" },
  { id: "bing", name: "Bing", icon: "🔎" },
  { id: "duckduckgo", name: "DuckDuckGo", icon: "🦆" },
  { id: "wikipedia", name: "Wikipedia", icon: "📚" },
  { id: "arxiv", name: "arXiv", icon: "📄" },
  { id: "github", name: "GitHub", icon: "💻" },
  { id: "stackoverflow", name: "Stack Overflow", icon: "💬" },
]
