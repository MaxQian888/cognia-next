/**
 * The sign-in providers this deployment offers, each only when its
 * credentials are configured (`config.ts`).
 *
 * Every provider asks for identity only. Provider tokens are discarded before
 * they reach D1 (`withoutProviderTokens` in auth.ts): login proves who the
 * person is, it never grants Cognia access to their provider account.
 */

import { genericOAuth } from "better-auth/plugins"

import type { IdentityConfig } from "../config"
import { feishuProviderConfig } from "./feishu"

export interface ProviderSetup {
  socialProviders: Record<string, unknown>
  plugins: ReturnType<typeof genericOAuth>[]
}

export interface ProviderSetupOptions {
  /** The minted Sign in with Apple client secret; required when Apple is configured. */
  appleClientSecret?: string
  fetchImpl?: typeof fetch
}

export function providerSetup(
  config: Pick<IdentityConfig, "providers">,
  options: ProviderSetupOptions = {}
): ProviderSetup {
  const { providers } = config
  const socialProviders: Record<string, unknown> = {}
  if (providers.github) {
    socialProviders.github = {
      clientId: providers.github.clientId,
      clientSecret: providers.github.clientSecret,
    }
  }
  if (providers.google) {
    socialProviders.google = {
      clientId: providers.google.clientId,
      clientSecret: providers.google.clientSecret,
      // Never ask Google for a refresh token: login only.
      accessType: "online",
      prompt: "select_account",
    }
  }
  if (providers.apple) {
    if (!options.appleClientSecret) {
      throw new Error("Sign in with Apple is configured but no client secret was minted")
    }
    socialProviders.apple = {
      clientId: providers.apple.serviceId,
      clientSecret: options.appleClientSecret,
      ...(providers.apple.appBundleId ? { appBundleIdentifier: providers.apple.appBundleId } : {}),
    }
  }
  const plugins = providers.feishu
    ? [genericOAuth({ config: [feishuProviderConfig(providers.feishu, options.fetchImpl)] })]
    : []
  return { socialProviders, plugins }
}
