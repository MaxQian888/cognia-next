//! Wire + storage types for the share service.
//!
//! The encrypted artifact itself (`ShareEnvelopeV1` on the TypeScript side) is
//! never modeled as a typed struct here: the server is a blind store and keeps
//! the envelope as opaque JSON text. We only model the *metadata* the server
//! actually reasons about — the lifecycle counters — plus the stats projection.

use serde::{Deserialize, Serialize};

/// Per-share lifecycle metadata. Mirrors the `ShareMeta` the Cloudflare Worker
/// persists in KV (`share-server/worker/src/index.ts`), one row per share.
///
/// Field naming is snake_case for the SQLite columns; the JSON stats projection
/// re-camelCases on the way out (see [`crate::proto::StatsView`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShareMeta {
    /// Unix epoch milliseconds at creation.
    pub created_at: i64,
    /// Unix epoch milliseconds at which the share auto-expires. `None` ⇒ never.
    pub expires_at: Option<i64>,
    /// Max successful views before self-destruct. `None` ⇒ unlimited.
    pub max_views: Option<u64>,
    /// Burn-after-read (equivalent to `max_views == Some(1)`, surfaced for UX).
    pub burn_after_read: bool,
    /// Successful views so far.
    pub view_count: u64,
    /// Owner-revoked flag. The Worker hard-deletes on revoke, so this is always
    /// `false` in practice; kept for stats parity and the read gate.
    pub revoked: bool,
}

/// Owner-only stats projection for `GET /v1/share/:code/stats`. Matches the
/// `ShareStats` wire type in `lib/share/types.ts` (camelCase, omits absent
/// optionals).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsView {
    pub view_count: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
    pub revoked: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_views: Option<u64>,
}

impl From<&ShareMeta> for StatsView {
    fn from(m: &ShareMeta) -> Self {
        Self {
            view_count: m.view_count,
            expires_at: m.expires_at,
            revoked: m.revoked,
            max_views: m.max_views,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stats_view_drops_absent_optionals() {
        let meta = ShareMeta {
            created_at: 1,
            expires_at: None,
            max_views: None,
            burn_after_read: false,
            view_count: 3,
            revoked: false,
        };
        let s = serde_json::to_string(&StatsView::from(&meta)).unwrap();
        assert!(s.contains("\"viewCount\":3"));
        assert!(!s.contains("expiresAt"));
        assert!(!s.contains("maxViews"));
        assert!(s.contains("\"revoked\":false"));
    }

    #[test]
    fn stats_view_keeps_present_optionals() {
        let meta = ShareMeta {
            created_at: 1,
            expires_at: Some(123),
            max_views: Some(5),
            burn_after_read: false,
            view_count: 2,
            revoked: false,
        };
        let s = serde_json::to_string(&StatsView::from(&meta)).unwrap();
        assert!(s.contains("\"expiresAt\":123"));
        assert!(s.contains("\"maxViews\":5"));
    }

    #[test]
    fn stats_view_serde_field_names_are_camel_case() {
        // The StatsView struct uses snake_case idents but must serialize as
        // camelCase to match the TS client; assert the rename attribute holds.
        let meta = ShareMeta {
            created_at: 0,
            expires_at: Some(1),
            max_views: Some(1),
            burn_after_read: true,
            view_count: 0,
            revoked: true,
        };
        let v: serde_json::Value = serde_json::to_value(StatsView::from(&meta)).unwrap();
        assert!(v.get("viewCount").is_some());
        assert!(v.get("expiresAt").is_some());
        assert!(v.get("maxViews").is_some());
        assert_eq!(v.get("revoked"), Some(&serde_json::Value::Bool(true)));
    }

    #[test]
    fn share_meta_round_trips_through_serde() {
        let meta = ShareMeta {
            created_at: 42,
            expires_at: Some(99),
            max_views: Some(3),
            burn_after_read: false,
            view_count: 1,
            revoked: false,
        };
        let json = serde_json::to_string(&meta).unwrap();
        let back: ShareMeta = serde_json::from_str(&json).unwrap();
        assert_eq!(meta, back);
    }
}
