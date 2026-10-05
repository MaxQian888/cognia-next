import type { Env } from "./env"

export interface SyncConfig {
  serviceEnv: string
  issuer: string
  audience: string
  webOrigins: string[]
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ConfigError"
  }
}

function httpsUrl(value: string | undefined, name: string, allowHttp: boolean): string {
  if (!value) throw new ConfigError(`${name} is not set`)
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ConfigError(`${name} is not a URL`)
  }
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) {
    throw new ConfigError(`${name} must be https`)
  }
  return value.replace(/\/+$/, "")
}

export function readConfig(env: Env): SyncConfig {
  const local = env.SERVICE_ENV === "dev" || env.SERVICE_ENV === "test"
  const webOrigins = (env.WEB_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
  for (const origin of webOrigins) {
    if (new URL(origin).origin !== origin)
      throw new ConfigError(`WEB_ORIGINS has a non-origin ${origin}`)
  }
  return {
    serviceEnv: env.SERVICE_ENV || "production",
    issuer: httpsUrl(env.ISSUER, "ISSUER", local),
    audience: httpsUrl(env.SYNC_AUDIENCE, "SYNC_AUDIENCE", false),
    webOrigins,
  }
}
