/**
 * The ACP vendor profiles Cognia ships, in resolution order for configurations
 * matched by executable rather than preset.
 */

import type { AcpVendorProfile } from "./vendor-profile"
import { clineAcpProfile } from "./vendors/cline"
import { devinAcpProfile } from "./vendors/devin"
import { gooseAcpProfile } from "./vendors/goose"
import { kimiAcpProfile } from "./vendors/kimi"
import { openCodeAcpProfile } from "./vendors/opencode"
import { qoderAcpProfile } from "./vendors/qoder"

export {
  clineAcpProfile,
  devinAcpProfile,
  gooseAcpProfile,
  kimiAcpProfile,
  openCodeAcpProfile,
  qoderAcpProfile,
}

export const ACP_VENDOR_PROFILES: readonly AcpVendorProfile[] = Object.freeze([
  kimiAcpProfile,
  clineAcpProfile,
  qoderAcpProfile,
  gooseAcpProfile,
  devinAcpProfile,
  openCodeAcpProfile,
])
