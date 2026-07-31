"use client"

/** Shared AI-provider brand icon with a deterministic monogram fallback. */
import { BrandIcon } from "@/components/icons/brand-icon"

interface ProviderIconProps {
  providerId: string
  className?: string
  decorative?: boolean
  label?: string
  /** Optional pixel size override; defaults to 24px (`size-6`). */
  size?: number
}

export function ProviderIcon({
  providerId,
  className,
  decorative = true,
  label,
  size = 24,
}: ProviderIconProps) {
  return (
    <BrandIcon
      id={providerId}
      className={className}
      decorative={decorative}
      label={label}
      size={size}
    />
  )
}

export default ProviderIcon
