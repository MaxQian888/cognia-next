import Image from "next/image"

import { cn } from "@/lib/utils"
import iconManifest from "@/public/icons/cognia-mobile-spots/icon-manifest.json"

const { runtimeFormats } = iconManifest
const WEBP_ICON_NAMES = new Set<string>(runtimeFormats.webp)

export const MOBILE_SPOT_ICON_NAMES = [
  "chat",
  "workflows",
  "discover",
  "profile",
  "agent-teams",
  "digital-twin",
  "skills",
  "browser",
  "canvas",
  "scheduler",
  "goals",
  "memory",
  "terminal",
  "connectors",
  "device-sync",
  "secure-backup",
  "templates",
  "plugins",
  "inbox",
  "devices",
  "subscription",
  "cloud-account",
  "remote-sessions",
  "appearance",
  "notifications",
  "preferences",
  "presets",
  "speech",
  "artifacts",
  "providers",
  "model-catalog",
  "ocr",
  "computer-use",
  "workspace",
  "issues",
  "issue-projects",
  "source-control",
  "command-history",
  "instructions",
  "subagents",
  "mcp",
  "external-agents",
  "slash-commands",
  "network",
  "hooks",
  "chat-templates",
  "characters",
  "teams",
  "agent-modes",
  "a2ui",
  "eval",
  "maintenance",
  "storage",
  "memory-settings",
  "about",
  "help",
  "feedback",
  "device-info",
  "logs",
  "diagnostics",
  "fleet",
  "servers",
  "pet",
  "agent-runs",
  "sites",
  "integrations",
  "bots",
  "performance",
  "usage-cost",
  "tools",
  "sidebar",
  "shortcuts",
  "gateway",
  "webhooks",
  "pro-ide",
  "lsp",
  "security",
  "workspace-trust",
  "sandbox",
  "image-catalog",
  "updates",
] as const

export type MobileSpotIconName = (typeof MOBILE_SPOT_ICON_NAMES)[number]

export interface MobileSpotIconProps {
  name: MobileSpotIconName
  size?: number
  className?: string
}

/** Decorative Cognia companion illustration for spacious mobile feature surfaces. */
export function MobileSpotIcon({ name, size = 64, className }: MobileSpotIconProps) {
  const format = WEBP_ICON_NAMES.has(name) ? "webp" : runtimeFormats.default
  return (
    <Image
      src={`/icons/cognia-mobile-spots/${format}/${name}.${format}`}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      draggable={false}
      className={cn("pointer-events-none select-none object-contain", className)}
      data-testid={`mobile-spot-icon-${name}`}
    />
  )
}
