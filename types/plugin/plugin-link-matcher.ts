/**
 * Inline chat-link contributions. Host project-file links always take precedence;
 * reasoning links deliberately do not consult this extension surface.
 *
 * Requires extension:ui. Matching is local and declarative; components receive
 * sanitized message URLs, which may contain private data. Network/model calls
 * must still use the permission-checked, PII-screened plugin APIs.
 */
import type { ComponentType, ReactNode } from "react"

export interface LinkMatcherProps {
  href: string
  children: ReactNode
  messageId?: string
  isStreaming?: boolean
}

interface LinkMatcherDefinition {
  /** Plugin-local identifier. Duplicate live identifiers are rejected. */
  id: string
  /**
   * HTTP(S) host/URL globs, e.g. github.com/org/repo/pull/* or *.figma.com/*.
   * An omitted scheme matches HTTP and HTTPS. A leading *. matches one or
   * more subdomain labels, never the base domain. * matches within a path
   * segment; ** crosses segments. Query/fragment are ignored unless included
   * explicitly in the pattern. Hostnames match case-insensitively.
   */
  patterns: string[]
  label?: string
  /** Higher priority first; ties sort by pluginId then id. Defaults to zero. */
  priority?: number
}

/** Manifest factory, imported only when a matching link first renders. */
export interface PluginLinkMatcherDef extends LinkMatcherDefinition {
  /** Relative path confined to the plugin install root. */
  entry: string
  /** Named React component export. Must render inline content, not a block. */
  export: string
}

/** Imperative equivalent exposed by ctx.chat.registerLinkMatcher. */
export interface PluginLinkMatcherRegistrationDef extends LinkMatcherDefinition {
  component: ComponentType<LinkMatcherProps>
}
