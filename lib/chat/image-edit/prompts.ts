/**
 * Fixed prompts the image workbench sends on the user's behalf.
 *
 * A leaf module on purpose. These are shared by the chat workbench and the
 * plugin Media API, and the obvious home for them (`ai-service.ts`) pulls in
 * the whole provider operation plane, which `media-api.ts` sits inside. The
 * import cycle that creates leaves the operation handler registry
 * half-initialised at module load, so the definition lives somewhere that
 * imports nothing but the dependency-free definition types. Each surface
 * resolves it itself (ADR-0236).
 */

import { definePrompt } from "@/lib/prompts/types"

/**
 * Background removal, an instruction to the image model.
 *
 * One definition, resolved by both surfaces rather than copied into each.
 * They previously carried byte-identical duplicates that agreed only by
 * coincidence, so the same button in two places could have drifted into two
 * different instructions to the model. Editable in the Prompt Center; neither
 * surface has a workspace or session to scope it to, so it is account-wide.
 */
export const REMOVE_BACKGROUND_PROMPT = definePrompt({
  id: "generation.image-edit.remove-background",
  contractVersion: 1,
  kind: "feature-template",
  group: "generation",
  operation: "replace-template",
  scopes: ["account"],
  activation: "next-operation",
  risk: "ordinary",
  hosts: ["app"],
  maxChars: 2_000,
  outputContract:
    "Sent as the prompt of an images.edit call; the edited image replaces the input (chat workbench: a new version; plugin Media API: the returned ImageData).",
  consumers: ["lib/chat/image-edit/ai-service.ts", "lib/plugin/api/media-api.ts"],
  defaultBody: "Remove the background from this image and keep the main subject cleanly isolated.",
})
