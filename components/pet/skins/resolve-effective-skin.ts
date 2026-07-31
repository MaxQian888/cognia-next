// Pure selection-time fallback: Live2D requires a ready runtime and active
// model. The sprite boundary owns its reactive asset lookup. Any gap degrades
// to the always-available SVG skin, so the renderer always has something to draw.

export interface EffectiveSkinOpts {
  /** Whether the Cubism Core runtime probe resolved true. */
  coreReady: boolean | undefined
  /** Whether an active Live2D model is configured. */
  hasActiveModel: boolean
  /** Whether the selected v2 sprite pack still exists in local storage. */
  hasActiveSpritePack?: boolean
}

export function resolveEffectiveSkin(skinId: string | undefined, opts: EffectiveSkinOpts): string {
  // The sprite skin owns its own reactive pack lookup and SVG fallback, just
  // like the Live2D boundary owns asynchronous load failures. Keep it selected
  // here so every surface reaches that boundary without duplicating a query.
  if (skinId === "sprite-v2" && opts.hasActiveSpritePack !== false) {
    return "sprite-v2"
  }
  if (skinId === "live2d" && opts.coreReady === true && opts.hasActiveModel) {
    return "live2d"
  }
  return "svg"
}
