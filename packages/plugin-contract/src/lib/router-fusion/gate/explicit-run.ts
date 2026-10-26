/**
 * The plugin contract's share of `lib/router-fusion/gate/explicit-run.ts`, which re-exports these.
 */

export type FusionActionChoice = (typeof FUSION_ACTION_CHOICES)[number]

export type DelegateDeliveryChoice = (typeof DELEGATE_DELIVERY_CHOICES)[number]

/**
 * What an agent turn, a Squad member or a workflow node may be set to.
 * `auto` is the default and means "unchanged": the caller's existing path.
 */
export const FUSION_ACTION_CHOICES = ["auto", "direct", "cascade", "panel", "delegate"] as const

/**
 * How a `delegate` choice delivers its verified change
 * (`FusionRunRow.delegateDelivery`). `patch_only` — the default, and what an
 * unset or unknown value reads as — hands back a patch and leaves the
 * checkout alone. `workspace_updated` writes the patch into the project's
 * checkout, but only after a person approves exactly that patch on exactly
 * that base (a `workspace_apply` approval, DEL-04).
 */
export const DELEGATE_DELIVERY_CHOICES = ["patch_only", "workspace_updated"] as const
