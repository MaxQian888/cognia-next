"use client"

/**
 * Lightweight provider icon. Cognia ships per-provider SVG branding under
 * `D:\Project\Cognia\components\providers\ai\provider-icon.tsx`; cognia-next
 * uses a generic monogram fallback so we don't ship 30+ vendor logos at the
 * port boundary. Components that want richer icons can swap this later.
 */
import { cn } from "@/lib/utils"

interface ProviderIconProps {
  providerId: string
  className?: string
  /** Optional pixel size override; defaults to 24px (`size-6`). */
  size?: number
}

export function ProviderIcon({ providerId, className, size }: ProviderIconProps) {
  const letter = (providerId?.[0] ?? "?").toUpperCase()
  const style = size ? { width: `${size}px`, height: `${size}px` } : undefined
  return (
    <div
      className={cn(
        "flex items-center justify-center rounded-md bg-muted text-xs font-semibold uppercase text-muted-foreground",
        !size && "h-6 w-6",
        className
      )}
      style={style}
      aria-hidden="true"
    >
      {letter}
    </div>
  )
}

export default ProviderIcon
