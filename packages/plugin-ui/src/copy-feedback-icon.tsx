import { CheckIcon, CopyIcon, type LucideProps } from "lucide-react"

export interface CopyFeedbackIconProps extends LucideProps {
  copied: boolean
}

/** Compact, motion-safe copy status icon for plugin actions. */
export function CopyFeedbackIcon({ copied, ...props }: CopyFeedbackIconProps) {
  const Icon = copied ? CheckIcon : CopyIcon
  return (
    <Icon
      aria-hidden="true"
      data-slot="copy-feedback-icon"
      data-state={copied ? "copied" : "idle"}
      {...props}
    />
  )
}
