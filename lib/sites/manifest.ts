import type { SiteResourceOwnership } from "@/types/sites"

export interface SiteHostingManifest {
  schemaVersion: 1
  build: {
    install?: string[]
    command: string[]
    entry: string
    assets?: string
  }
  preview: {
    command: string[]
    url: string
  }
  cloudflare: {
    compatibilityDate: string
    compatibilityFlags: string[]
    bindings: Array<{
      kind: "d1" | "r2"
      name: string
      resourceName: string
      ownership: SiteResourceOwnership
      providerResourceId?: string
    }>
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function strictKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string
): void {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key))
  if (extra.length > 0) throw new Error(`${label} contains unsupported fields: ${extra.join(", ")}`)
}

function argv(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((part) => typeof part !== "string")
  ) {
    throw new Error(`${label} must be a non-empty argv array`)
  }
  const parts = value.map((part) => part.trim())
  if (parts.some((part) => !part)) throw new Error(`${label} argv cannot contain blank parts`)
  return parts
}

function relativePath(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`)
  const normalized = value.trim().replaceAll("\\", "/")
  if (/^(?:\/|[a-zA-Z]:\/)/.test(normalized)) throw new Error(`${label} must be relative`)
  const result: string[] = []
  for (const part of normalized.split("/")) {
    if (!part || part === ".") continue
    if (part === "..") {
      if (result.length === 0) throw new Error(`${label} cannot escape the Site source root`)
      result.pop()
    } else {
      result.push(part)
    }
  }
  if (result.length === 0) throw new Error(`${label} cannot resolve to the source root`)
  return result.join("/")
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be a string array`)
  }
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))]
}

function previewUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("preview.url is required")
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error("preview.url must be a valid localhost URL")
  }
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)
  if (!local || !["http:", "https:"].includes(url.protocol)) {
    throw new Error("preview.url must use localhost")
  }
  return url.toString().replace(/\/$/, "")
}

export function parseSiteHostingManifest(text: string): SiteHostingManifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error("Cognia Sites manifest must be valid JSON")
  }
  const root = object(parsed, "manifest")
  strictKeys(root, ["schemaVersion", "build", "preview", "cloudflare"], "manifest")
  if (root.schemaVersion !== 1) throw new Error("unsupported Cognia Sites manifest schema version")

  const build = object(root.build, "build")
  strictKeys(build, ["install", "command", "entry", "assets"], "build")
  const preview = object(root.preview, "preview")
  strictKeys(preview, ["command", "url"], "preview")
  const cloudflare = object(root.cloudflare, "cloudflare")
  strictKeys(cloudflare, ["compatibilityDate", "compatibilityFlags", "bindings"], "cloudflare")
  if (
    typeof cloudflare.compatibilityDate !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(cloudflare.compatibilityDate)
  ) {
    throw new Error("cloudflare.compatibilityDate must use YYYY-MM-DD")
  }
  if (!Array.isArray(cloudflare.bindings)) {
    throw new Error("cloudflare.bindings must be an array")
  }
  const bindings = cloudflare.bindings.map((raw, index) => {
    const binding = object(raw, `cloudflare.bindings[${index}]`)
    strictKeys(
      binding,
      ["kind", "name", "resourceName", "ownership", "providerResourceId"],
      `cloudflare.bindings[${index}]`
    )
    if (binding.kind !== "d1" && binding.kind !== "r2") {
      throw new Error(`cloudflare binding kind is unsupported: ${String(binding.kind)}`)
    }
    if (typeof binding.name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(binding.name)) {
      throw new Error("cloudflare binding name must be a JavaScript identifier")
    }
    if (typeof binding.resourceName !== "string" || !binding.resourceName.trim()) {
      throw new Error("cloudflare binding resourceName is required")
    }
    if (!["managed", "adopted", "shared"].includes(String(binding.ownership))) {
      throw new Error("cloudflare binding ownership is invalid")
    }
    if (
      binding.providerResourceId !== undefined &&
      typeof binding.providerResourceId !== "string"
    ) {
      throw new Error("cloudflare binding providerResourceId must be a string")
    }
    return {
      kind: binding.kind as "d1" | "r2",
      name: binding.name,
      resourceName: binding.resourceName.trim(),
      ownership: binding.ownership as SiteResourceOwnership,
      ...(typeof binding.providerResourceId === "string"
        ? { providerResourceId: binding.providerResourceId }
        : {}),
    }
  })

  return {
    schemaVersion: 1,
    build: {
      ...(build.install === undefined ? {} : { install: argv(build.install, "build.install") }),
      command: argv(build.command, "build.command"),
      entry: relativePath(build.entry, "build.entry"),
      ...(build.assets === undefined ? {} : { assets: relativePath(build.assets, "build.assets") }),
    },
    preview: {
      command: argv(preview.command, "preview.command"),
      url: previewUrl(preview.url),
    },
    cloudflare: {
      compatibilityDate: cloudflare.compatibilityDate,
      compatibilityFlags: stringArray(
        cloudflare.compatibilityFlags,
        "cloudflare.compatibilityFlags"
      ),
      bindings,
    },
  }
}
