---
"cognia-next": patch
---

Keep recalled IM messages withdrawn across delayed edits, hide stale quotes and drafts, display cached inbound images without replaying them to models, and preserve code and unrelated attachments when formatting and deduplicating cards.

Fence stale transcript and metadata writes, retain edits and recalls before insertion, order wire revisions, rebuild invalidated provider history, withhold resolved data URLs from model text, and keep callback controls inert even when action IDs are absent or malformed.

Wrap long IM card labels on narrow screens, reuse the read-only image lightbox with edit/recall-aware preview state, and isolate raw-payload serialization failures while localizing reply context.

Preserve previews across identical history refreshes, clear obsolete selections and recover from invalid card replacements. Scrub legacy inline display media from group/reply/reference text, bound excessive external Markdown nesting, and keep overflowing thumbnail galleries reachable on narrow screens.

Align DingTalk nested rich text, WeCom quotes and voice transcripts, OneBot 12 candidate segments, QQ attachments/references and Matrix media captions with current primary contracts. Preserve media occurrence order, isolate malformed protocol members through the resolver, and retain stable bounded image references when caches rewrite URLs to inline bytes.

Keep DingTalk and QQ receive streams alive after malformed frames and surface official QQ recalls. Validate Matrix edit authors and stable revision ordering across recovery, preserve reply references through queued edits, and match Matrix/QQ replies against delivered public IDs. Withhold legacy binary parts from model history, contain malformed stored segments and oversized inline display URLs, and keep failed WeCom downloads opaque with image-signature validation. Preserve repeated source occurrences without duplicating whole message bodies; callback buttons remain read-only.

Keep edits and recalls consistent through reconnects, duplicate delivery and durable history recovery. Complete Matrix gap pagination before checkpointing, ignore obsolete transport continuations, preserve recall fences through pruning, and rebuild recovered turns from canonical text in the original session. Recheck the accepted source at actual send admission after asynchronous preparation; historical display media remains withheld and callback controls remain read-only.

Replay unapplied edits and recalls after crashes, acknowledge only the exact committed mutation, and retain pending intent while its canonical message survives. Protect connector rows from stale cross-window snapshots, deduplicate history insertion across bound sessions, and fence prepared group/reply context against concurrent mutations. Retain Matrix replacement history through job pruning so redacted edits revert to known prior content; replacement events cannot introduce reply or callback relationships. Display media stays outside model history and callback buttons remain read-only.

Harden personal WeChat and Official Account reception against malformed messages, failed media, duplicate delivery and interrupted recovery. Persist account-scoped personal cursors after durable admission without restarting the connection. Journal verified OA callbacks in encrypted native storage before acknowledgement, reconcile missed notifications, and acknowledge exact accepted records. Validate cached media and headless resolution, keep ciphertext links unavailable, preserve distinct media occurrences and render voice recognition once. Fence credential replacement/removal and propagate failed file sync before committing retained callbacks. Historical model replay excludes display bytes and inbound callback controls remain read-only.

Fence personal cursor commits with configuration/checkpoint compare-and-swap and opaque credential revisions, including same-value credential replacement. Atomically persist credential ownership and dependent state. Transfer OA inbox occurrences through a durable native claim before JS admission, retain claimed handoffs across revocation, and retry exact ACKs without repeating accepted work. Use unique occurrence IDs against delayed ACKs and distinguish different same-second menu clicks; display media and callback controls retain their isolated, read-only behavior.
