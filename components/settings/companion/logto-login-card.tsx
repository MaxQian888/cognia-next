"use client"

/**
 * Compatibility name for the cloud deployment card.
 *
 * The manual Logto form that lived here (issuer, client id, resource,
 * redirect URI, hand-run PKCE) is gone: it produced a token and no
 * membership, so a person who used it was signed in and in no workspace.
 * Callers that still mount `LogtoLoginCard` get the deployment card, which
 * hands sign-in to the gate that does the whole flow.
 */

export {
  CloudDeploymentCard as LogtoLoginCard,
  CloudDeploymentCard as default,
} from "./cloud-deployment-card"
export { extractCallback } from "@/lib/logto/extract-callback"
