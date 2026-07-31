import { z } from "zod"
import type { EvalPortableManifest } from "./types"

const portableManifestSchema = z
  .object({
    schema: z.literal("cognia-eval/v2"),
    exportedAt: z.string().datetime(),
    project: z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      mode: z.enum(["model", "agent"]),
      datasetDigest: z.string().min(1),
    }),
    experiment: z.object({
      id: z.string().min(1),
      status: z.enum([
        "draft",
        "preflight",
        "queued",
        "running",
        "paused",
        "interrupted",
        "completed",
        "failed",
        "cancelled",
      ]),
      randomSeed: z.number().int(),
      appVersion: z.string().min(1),
    }),
    variants: z.array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        providerId: z.string().optional(),
        modelId: z.string().optional(),
      })
    ),
    aggregates: z.array(z.record(z.string(), z.unknown())),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()

const SECRET_KEY = /(api[-_]?key|credential|secret|password|token|authorization)/i

function assertSecretFree(value: unknown, path = "manifest"): void {
  if (!value || typeof value !== "object") return
  for (const [key, nested] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) {
      throw new Error(
        `Portable evaluation manifests cannot contain secret references (${path}.${key})`
      )
    }
    assertSecretFree(nested, `${path}.${key}`)
  }
}

export function parsePortableManifest(input: string | unknown): EvalPortableManifest {
  const parsedInput: unknown = typeof input === "string" ? JSON.parse(input) : input
  assertSecretFree(parsedInput)
  return portableManifestSchema.parse(parsedInput)
}

export function serializePortableManifest(manifest: EvalPortableManifest): string {
  return JSON.stringify(parsePortableManifest(manifest), null, 2)
}
