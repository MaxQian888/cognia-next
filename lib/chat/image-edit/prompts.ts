/**
 * Fixed prompts the image workbench sends on the user's behalf.
 *
 * A leaf module on purpose. These are shared by the chat workbench and the
 * plugin Media API, and the obvious home for them (`ai-service.ts`) pulls in
 * the whole provider operation plane, which `media-api.ts` sits inside. The
 * import cycle that creates leaves the operation handler registry
 * half-initialised at module load, so the constant lives somewhere that
 * imports nothing.
 */

/**
 * Background removal.
 *
 * One string, imported by both surfaces rather than copied into each. They
 * previously carried byte-identical duplicates that agreed only by
 * coincidence, so the same button in two places could have drifted into two
 * different instructions to the model.
 */
export const REMOVE_BACKGROUND_PROMPT =
  "Remove the background from this image and keep the main subject cleanly isolated."
