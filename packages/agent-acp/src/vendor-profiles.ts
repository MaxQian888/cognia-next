/**
 * The ACP vendor profiles Cognia ships, in resolution order for configurations
 * matched by executable rather than preset.
 */

import type { AcpVendorProfile } from "./vendor-profile"
import { antigravityAcpProfile } from "./vendors/antigravity"
import { clineAcpProfile } from "./vendors/cline"
import { copilotAcpProfile } from "./vendors/copilot"
import { devinAcpProfile } from "./vendors/devin"
import { grokAcpProfile } from "./vendors/grok"
import { gooseAcpProfile } from "./vendors/goose"
import { minimaxAcpProfile } from "./vendors/minimax"
import { kimiAcpProfile } from "./vendors/kimi"
import { openCodeAcpProfile } from "./vendors/opencode"
import { qoderAcpProfile } from "./vendors/qoder"
import { CATALOG_EXPANSION_ACP_PROFILES } from "./vendors/catalog-expansion"
export * from "./vendors/catalog-expansion"

export {
  antigravityAcpProfile,
  minimaxAcpProfile,
  clineAcpProfile,
  copilotAcpProfile,
  devinAcpProfile,
  gooseAcpProfile,
  grokAcpProfile,
  kimiAcpProfile,
  openCodeAcpProfile,
  qoderAcpProfile,
}

export const ACP_VENDOR_PROFILES: readonly AcpVendorProfile[] = Object.freeze([
  antigravityAcpProfile,
  minimaxAcpProfile,
  kimiAcpProfile,
  clineAcpProfile,
  copilotAcpProfile,
  qoderAcpProfile,
  gooseAcpProfile,
  grokAcpProfile,
  devinAcpProfile,
  openCodeAcpProfile,
  ...CATALOG_EXPANSION_ACP_PROFILES,
])
