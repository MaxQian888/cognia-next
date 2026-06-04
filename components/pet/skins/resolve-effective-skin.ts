// Pure selection-time fallback: the live2d skin only renders when the user picked
// it AND the Cubism Core runtime is ready AND an active model exists. Any gap
// degrades to the always-available SVG skin, so the renderer never ends up with
// a skin it can't draw.

export interface EffectiveSkinOpts {
  /** Whether the Cubism Core runtime probe resolved true. */
  coreReady: boolean | undefined
  /** Whether an active Live2D model is configured. */
  hasActiveModel: boolean
}

export function resolveEffectiveSkin(skinId: string | undefined, opts: EffectiveSkinOpts): string {
  if (skinId === "live2d" && opts.coreReady === true && opts.hasActiveModel) {
    return "live2d"
  }
  return "svg"
}
