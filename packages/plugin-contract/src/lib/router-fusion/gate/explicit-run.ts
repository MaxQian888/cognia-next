/**
 * The plugin contract's share of `lib/router-fusion/gate/explicit-run.ts`, which re-exports these.
 */
import type {
  DELEGATE_DELIVERY_CHOICES,
  FUSION_ACTION_CHOICES,
} from "@/lib/router-fusion/gate/explicit-run"

export type FusionActionChoice = (typeof FUSION_ACTION_CHOICES)[number]

export type DelegateDeliveryChoice = (typeof DELEGATE_DELIVERY_CHOICES)[number]
