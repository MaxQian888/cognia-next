/**
 * A slot contribution, showing the three things plugin UI has to get right.
 *
 * 1. Components come from `@cognia/plugin-ui`, which the build marks external
 *    and the host resolves at load. Never bundle React or the kit — a second
 *    React instance has its own hook dispatcher and every hook here throws.
 * 2. Colors, spacing and radius come from the host's CSS custom properties, so
 *    this follows the user's theme and density with no work.
 * 3. Animation driven from JavaScript must check `motion.reduced` itself. CSS
 *    animation is collapsed for you by the host's reduce-motion reset; the Web
 *    Animations API and `requestAnimationFrame` are not.
 */

import { useEffect, useRef, useState } from "react"
import { Badge, Button } from "@cognia/plugin-ui"
import type { ExtensionProps, PluginContext } from "@cognia/plugin-sdk"

export interface PanelProps extends ExtensionProps {
  ctx: PluginContext
}

export function TemplatePanel({ formFactor, ctx }: PanelProps) {
  const [count, setCount] = useState(0)
  const [, setLocale] = useState(ctx.i18n.getCurrentLocale())
  const pulseRef = useRef<HTMLSpanElement>(null)

  const theme = ctx.theme.getTheme()
  const reduced = theme.motion.reduced
  const durationScale = theme.motion.durationScale

  useEffect(() => ctx.i18n.onLocaleChange(setLocale), [ctx.i18n])

  useEffect(() => {
    const node = pulseRef.current
    if (!node) return
    // The check that matters: without it this keeps animating after the user
    // has asked the whole app to stop.
    if (reduced) return

    const animation = node.animate([{ opacity: 0.4 }, { opacity: 1 }], {
      duration: 600 * durationScale,
      iterations: Infinity,
      direction: "alternate",
    })
    return () => animation.cancel()
  }, [reduced, durationScale, count])

  // `icon` slots are ~24-32px of chrome — a label does not fit.
  if (formFactor === "icon") {
    return (
      <Button size="icon-sm" variant="ghost" onClick={() => setCount((c) => c + 1)}>
        <span ref={pulseRef}>★</span>
      </Button>
    )
  }

  return (
    <div className="template-panel">
      <Badge variant="secondary">
        <span ref={pulseRef}>
          {ctx.i18n.t(reduced ? "panel.status.static" : "panel.status.live")}
        </span>
      </Badge>
      <Button size="sm" onClick={() => setCount((c) => c + 1)}>
        {ctx.i18n.t("panel.clicked", { count })}
      </Button>
    </div>
  )
}
