import {
  buildA2UICapabilityMatrix,
  type A2UICapabilityMatrix,
  type Capability,
} from "@/types/connectors/capability"

/** Customer-service messages support text, image, voice, and video (with a thumbnail). */
export const WECHAT_OA_CAPS: readonly Capability[] = [
  "send.text",
  "send.image",
  "send.voice",
  "send.video",
  "typing",
] as const

/** A2UI degrades to the plain-text mirror — WeChat OA text has no interactive surface. */
export const WECHAT_OA_A2UI_CAPABILITY: A2UICapabilityMatrix = buildA2UICapabilityMatrix({})
