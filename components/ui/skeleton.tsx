import { cn } from "@/lib/utils"

/**
 * Placeholder block for content that has not arrived yet.
 *
 * Hidden from assistive tech by default. A skeleton is a *picture* of absent
 * content, and a loading region routinely renders a dozen of them — announcing
 * each one floods a screen reader with noise that carries no information. The
 * announcement belongs to the region instead: wrap the area in `LoadingRegion`
 * (`components/ui/loading-region.tsx`), which owns the `aria-busy` state and a
 * single polite live message. Callers may still pass `aria-hidden={false}` for
 * the rare standalone case.
 *
 * The `data-slot="skeleton"` marker is load-bearing beyond styling: the
 * reduce-motion tier in `globals.css` keys the pulse exemption off it, so a
 * skeleton keeps breathing when the user has asked for reduced motion rather
 * than freezing into an inert grey box.
 */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn("animate-pulse rounded-md bg-accent", className)}
      {...props}
    />
  )
}

export { Skeleton }
