---
"cognia-next": patch
---

Settings → Conversation → Composer style now reports the style the composer is actually rendering. Which skin is the default belongs to the active style pack (Soft and Studio default to Classic, Sharp defaults to Sharp), but the picker fell straight back to Classic whenever no skin was pinned — so under the Sharp pack it read "Classic (current look)", showed Classic's 16px corner radius, and greyed out the Adjust group claiming Classic takes no adjustments, all while the composer rendered a squared-off Sharp box that does take them. The card now resolves through the pack exactly as the composer does, and says when the row is inherited rather than pinned. Classic's copy no longer claims to be the current look or the default, since under Sharp it is neither.
