/** @cognia-host-integration-test */
/**
 * The governance plugin builds Prompt Center links without host imports
 * (public SDK only). This pins its URL to the params the host's settings
 * section reads, so a rename on either side fails here.
 */
import {
  PROMPT_RESOURCE_PARAM,
  PROMPT_WORKSPACE_PARAM,
  SETTINGS_ROUTE,
} from "@/lib/settings/deep-link"
import { promptCenterHref } from "./runtime"

describe("Prompt Center deep links", () => {
  it("carry the params the host's prompts section reads", () => {
    expect(promptCenterHref("k", null)).toBe(`${SETTINGS_ROUTE}?section=prompts&resource=k`)
    const href = promptCenterHref("instruction-file:%2Frepo|CLAUDE.md", "ws 1")
    const params = new URLSearchParams(href.split("?")[1])
    expect(params.get("section")).toBe("prompts")
    expect(params.get(PROMPT_RESOURCE_PARAM)).toBe("instruction-file:%2Frepo|CLAUDE.md")
    expect(params.get(PROMPT_WORKSPACE_PARAM)).toBe("ws 1")
  })
})
