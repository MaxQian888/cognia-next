"use client"

/**
 * The sentence for each reason an "add external agent" form cannot be
 * submitted. The keys predate the shared form and stay where they were, in
 * the namespaces the desktop dialog has always used, so both surfaces say the
 * same thing for the same mistake.
 */

import { useCallback } from "react"
import { useTranslations } from "next-intl"

import type { AddAgentFormProblem } from "@/lib/ai/agent/external/config/add-agent-form"

export function useAddAgentProblemMessage(): (problem: AddAgentFormProblem) => string {
  const tSettings = useTranslations("externalAgent.settings")
  const tManager = useTranslations("externalAgent.manager")
  const tGateway = useTranslations("externalAgent.cogniaModel")
  return useCallback(
    (problem: AddAgentFormProblem) => {
      switch (problem) {
        case "unsupportedProtocol":
          return tManager("unsupportedProtocol")
        case "nameRequired":
          return tSettings("nameRequired")
        case "endpointRequired":
          return tSettings("endpointRequired")
        case "commandRequired":
          return tSettings("commandRequired")
        case "cogniaModelInvalid":
          return tGateway("invalid")
        case "argumentsInvalid":
          return tSettings("argumentsInvalid")
        case "environmentInvalid":
          return tSettings("environmentInvalid")
      }
    },
    [tGateway, tManager, tSettings]
  )
}
