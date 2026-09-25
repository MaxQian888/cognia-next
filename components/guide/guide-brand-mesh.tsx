import { cn } from "@/lib/utils"

/**
 * The brand substrate behind a guide's narrative panel.
 *
 * Two soft stops of `--brand-action` / `--brand-approval` over the app's own
 * background, so the panel reads as a different surface without becoming a
 * different product. The stops are mixed at 12–18% alpha in `globals.css`
 * (`--brand-mesh-from` / `--brand-mesh-to`) and this layer never sits behind
 * text: the site's own spec measures the cyan at 1.69:1 on a light ground
 * (ADR-0092 V2 §8). `pointer-events-none` because it covers the whole panel.
 *
 * Both full-window flows drew this inline, byte for byte; one copy is what
 * stops the next palette change from landing on only one of them.
 */
export function GuideBrandMesh({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      data-slot="guide-brand-mesh"
      className={cn("pointer-events-none absolute inset-0 bg-background", className)}
      style={{
        backgroundImage:
          "radial-gradient(90% 70% at 18% 12%, var(--brand-mesh-from), transparent 70%), radial-gradient(80% 60% at 88% 96%, var(--brand-mesh-to), transparent 72%)",
      }}
    />
  )
}
