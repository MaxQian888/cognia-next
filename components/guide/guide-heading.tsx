import { cn } from "@/lib/utils"

export interface GuideHeadingProps {
  title: string
  description?: string
  /**
   * `step` is every step's title. `hero` is the one screen whose whole job is
   * to say what the product is (the first-run welcome).
   */
  size?: "step" | "hero"
  className?: string
}

/**
 * The page heading of a guided step (ADR-0193).
 *
 * Every step of every full-window guide opens with this, so the title sits at
 * the same size, weight and rhythm whether the user is signing in, scanning a
 * machine or pairing a phone. It is the page's `h1`; the narrative panel's
 * headline beside it is narration, not a second title.
 */
export function GuideHeading({ title, description, size = "step", className }: GuideHeadingProps) {
  const hero = size === "hero"
  return (
    <div className={cn("flex flex-col", hero ? "gap-4" : "mb-6 gap-2", className)}>
      <h1
        className={cn(
          "text-balance font-semibold tracking-tight",
          hero ? "text-4xl leading-[1.05] sm:text-5xl" : "text-2xl sm:text-[1.75rem]"
        )}
      >
        {title}
      </h1>
      {description && (
        <p
          className={cn(
            "leading-relaxed",
            hero
              ? "max-w-[38ch] text-base text-foreground"
              : "max-w-[46ch] text-sm text-muted-foreground"
          )}
        >
          {description}
        </p>
      )}
    </div>
  )
}
