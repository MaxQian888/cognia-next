/**
 * A rough image token cost, for showing the user what a frame choice weighs.
 *
 * Uses Anthropic's published approximation (tokens ≈ width × height / 750
 * after the image is fitted to 1568 px on the long edge and ~1.15 megapixels),
 * which is also in the right range for Gemini and OpenAI tiles. It is labelled
 * an estimate wherever it is shown. It deliberately does NOT feed
 * `ExtractedAttachment.tokens`: that field has always counted inline text only,
 * and folding image cost into it would trip the composer's text-size
 * confirmation for a handful of screenshots.
 */

const MAX_LONG_EDGE = 1568
const MAX_PIXELS = 1_150_000
const PIXELS_PER_TOKEN = 750

export function estimateImageTokens(width: number, height: number): number {
  if (!(width > 0) || !(height > 0)) return 0
  let w = width
  let h = height
  const edgeScale = Math.min(1, MAX_LONG_EDGE / Math.max(w, h))
  w *= edgeScale
  h *= edgeScale
  const areaScale = Math.min(1, Math.sqrt(MAX_PIXELS / (w * h)))
  w *= areaScale
  h *= areaScale
  return Math.ceil((w * h) / PIXELS_PER_TOKEN)
}
