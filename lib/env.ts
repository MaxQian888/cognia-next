export type PublicEnv = {
  appName: string
  apiUrl: string | undefined
}

const REQUIRED = ["NEXT_PUBLIC_APP_NAME"] as const

/**
 * Reads NEXT_PUBLIC_* env vars and validates required ones.
 * Throws on first call if a required var is missing — see .env.example.
 */
export function getPublicEnv(): PublicEnv {
  const missing = REQUIRED.filter((key) => !process.env[key])
  if (missing.length > 0) {
    throw new Error(`Missing required public env vars: ${missing.join(", ")}. See .env.example.`)
  }
  return {
    appName: process.env.NEXT_PUBLIC_APP_NAME as string,
    apiUrl: process.env.NEXT_PUBLIC_API_URL,
  }
}
