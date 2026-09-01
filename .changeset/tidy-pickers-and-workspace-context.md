---
"cognia-next": minor
---

Pickers, workspace context and worktrees.

Every searchable picker now shares one frame: an anchored popover on a desktop
pane, a full-width bottom sheet with 44px rows on a phone. Model, thinking
level, agent composition, Squad and the three settings model pickers all move
onto it, so a picker opened from a composer chip no longer opens into the
keyboard. The frame carries the overlay surface tier, which means the style
packs' elevation ceiling reaches pickers for the first time.

The Squad picker shows what each Squad is: portrait, roster size, and a dot that
separates running from parked-on-your-answer. It filters past six Squads.

The branch now sits beside the workspace it is inside, in the sidebar's title
bar on a desktop and in the workspace sheet on a phone. Switching branch,
creating, renaming and deleting one no longer means leaving the conversation.

Worktrees: /workspace tabs are linkable (?tab=), every environment row leads
with a named state dot, and the phone's Source Control screen points at where
worktrees actually live instead of silently omitting them.

Three copies of the settings model list become one. The workspace manage
dialog stops offering a "Browse server" button that opens a picker with nothing
to list, and says why instead.
