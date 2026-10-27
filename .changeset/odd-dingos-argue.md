---
"cognia-next": patch
---

Fix Live2D pet customization updates, disabled mouth animation, and complete official sample imports. Keep desktop pets open through first paint, project the selected account model into secondary windows without sharing account keys, and clear revoked or superseded asset loads. Localize every configurable model state.

Support local Bigfish video and ordered-frame animation packs, including ZIP/folder import, account-scoped storage, character selection and desktop playback. Preserve WebM transparency through bounded native atlas conversion. Increase the initial desktop size to 256px while retaining saved sizes, and route secondary-window preference updates through the active account owner.

Compress video atlases with bundled WebP encoding while preserving alpha and existing import limits. Reject oversized source dimensions before decoding. Recover an uninitialized Tauri debug window by navigating once to the compiled frontend after authenticating the current session.
