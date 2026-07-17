import Image from "next/image"

import { cn } from "@/lib/utils"

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
] as const

export type MobileSpotIconName = (typeof MOBILE_SPOT_ICON_NAMES)[number]

export interface MobileSpotIconProps {
  name: MobileSpotIconName
  size?: number
  className?: string
}

/** Decorative Cognia companion illustration for spacious mobile feature surfaces. */
export function MobileSpotIcon({ name, size = 64, className }: MobileSpotIconProps) {
  return (
    <Image
      src={`/icons/cognia-mobile-spots/png/${name}.png`}
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
