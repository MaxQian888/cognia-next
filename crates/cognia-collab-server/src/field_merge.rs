//! Field-level merge for stale writes (ADR-0208).
//!
//! Every accepted write bumps a record's `revision` and stamps each field it
//! changed with that revision and its author. A later write whose
//! `baseRevision` is stale is still applied when none of the fields it names
//! changed after its base; only a real same-field clash becomes a 409, and that
//! 409 names the clashing fields instead of handing back the whole record.
//!
//! Pure functions over a `jsonb` map so the Postgres and in-memory stores run
//! the same rule.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// When one field last changed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FieldStamp {
    pub revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub by: Option<String>,
}

/// `field name -> stamp`, stored as the row's `field_revisions` jsonb.
pub type FieldRevisions = BTreeMap<String, FieldStamp>;

/// The revision tracking started from on this row. Every change after it is
/// stamped, so a field with no stamp last changed at or before it. A row with
/// no marker predates tracking, and its unstamped fields may have changed at
/// any revision.
pub const TRACKED_SINCE: &str = "$since";

/// One field a stale write touched that changed after its base.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldClash {
    pub field: String,
    pub changed_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub changed_by: Option<String>,
}

/// What a write against a record at `current_revision` may do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MergeDecision {
    /// Apply the patch.
    Apply,
    /// Refuse it; every clash is listed, in field order.
    Clash(Vec<FieldClash>),
    /// A base that cannot be honest: ahead of the record, or below 1.
    InvalidBase,
}

/// Decide whether a patch naming `touched` fields, written against
/// `base_revision`, may apply to a record now at `current_revision`.
///
/// Fields in `last_writer_wins` never clash: they are ordered by the server
/// and the later write simply wins (a card's board position is the example).
pub fn decide(
    current_revision: i64,
    base_revision: i64,
    stamps: &FieldRevisions,
    touched: &[String],
    last_writer_wins: &[&str],
) -> MergeDecision {
    if base_revision < 1 || base_revision > current_revision {
        return MergeDecision::InvalidBase;
    }
    if base_revision == current_revision {
        return MergeDecision::Apply;
    }
    let mut clashes: Vec<FieldClash> = touched
        .iter()
        .filter(|field| !last_writer_wins.contains(&field.as_str()))
        .filter_map(|field| {
            // An unstamped field last changed at or before the tracking
            // marker; on a row with no marker it may have changed at any
            // revision, so it counts as changed at the latest.
            let (changed_at, changed_by) = match stamps.get(field) {
                Some(stamp) => (stamp.revision, stamp.by.clone()),
                None => match stamps.get(TRACKED_SINCE) {
                    Some(since) => (since.revision, None),
                    None => (current_revision, None),
                },
            };
            (changed_at > base_revision).then(|| FieldClash {
                field: field.clone(),
                changed_at,
                changed_by,
            })
        })
        .collect();
    if clashes.is_empty() {
        return MergeDecision::Apply;
    }
    clashes.sort_by(|a, b| a.field.cmp(&b.field));
    clashes.dedup_by(|a, b| a.field == b.field);
    MergeDecision::Clash(clashes)
}

/// Stamp each touched field with the revision the write produced. The first
/// tracked write also records [`TRACKED_SINCE`] as the revision before it:
/// from here on every change is stamped.
pub fn stamp(stamps: &mut FieldRevisions, touched: &[String], revision: i64, by: Option<&str>) {
    stamps
        .entry(TRACKED_SINCE.to_owned())
        .or_insert(FieldStamp {
            revision: revision - 1,
            by: None,
        });
    for field in touched {
        stamps.insert(
            field.clone(),
            FieldStamp {
                revision,
                by: by.map(str::to_owned),
            },
        );
    }
}

/// Parse a stored map; an unreadable one is treated as empty, which is the
/// conservative reading (every field counts as changed at the latest).
pub fn parse(value: &serde_json::Value) -> FieldRevisions {
    serde_json::from_value(value.clone()).unwrap_or_default()
}

/// The 409 body's `fields` object: clashing field -> ours, theirs, and who.
pub fn clash_report(
    clashes: &[FieldClash],
    ours: &serde_json::Value,
    theirs: &serde_json::Value,
) -> serde_json::Value {
    let mut report = serde_json::Map::new();
    for clash in clashes {
        let lookup = |value: &serde_json::Value| {
            clash
                .field
                .split('.')
                .try_fold(value, |node, key| node.get(key))
                .cloned()
                .unwrap_or(serde_json::Value::Null)
        };
        report.insert(
            clash.field.clone(),
            serde_json::json!({
                "yours": lookup(ours),
                "theirs": lookup(theirs),
                "changedAt": clash.changed_at,
                "changedBy": clash.changed_by,
            }),
        );
    }
    serde_json::Value::Object(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touched(fields: &[&str]) -> Vec<String> {
        fields.iter().map(|f| (*f).to_owned()).collect()
    }

    fn stamps(entries: &[(&str, i64)]) -> FieldRevisions {
        entries
            .iter()
            .map(|(field, revision)| {
                (
                    (*field).to_owned(),
                    FieldStamp {
                        revision: *revision,
                        by: Some(format!("usr_{field}")),
                    },
                )
            })
            .collect()
    }

    #[test]
    fn a_current_base_always_applies() {
        assert_eq!(
            decide(3, 3, &stamps(&[]), &touched(&["title"]), &[]),
            MergeDecision::Apply
        );
    }

    #[test]
    fn a_stale_base_applies_when_the_named_fields_did_not_change_after_it() {
        let s = stamps(&[("status", 3), ("priority", 2)]);
        assert_eq!(
            decide(3, 2, &s, &touched(&["priority"]), &[]),
            MergeDecision::Apply
        );
    }

    #[test]
    fn a_stale_base_clashes_on_a_field_changed_after_it() {
        let s = stamps(&[("status", 3), ("priority", 2)]);
        assert_eq!(
            decide(3, 2, &s, &touched(&["status", "priority"]), &[]),
            MergeDecision::Clash(vec![FieldClash {
                field: "status".into(),
                changed_at: 3,
                changed_by: Some("usr_status".into()),
            }])
        );
    }

    #[test]
    fn last_writer_wins_fields_never_clash() {
        let s = stamps(&[("board_order", 5)]);
        assert_eq!(
            decide(5, 1, &s, &touched(&["board_order"]), &["board_order"]),
            MergeDecision::Apply
        );
    }

    #[test]
    fn an_untracked_field_on_a_moved_legacy_record_counts_as_changed() {
        // Rows written before field tracking have no marker at all.
        assert!(matches!(
            decide(4, 2, &FieldRevisions::new(), &touched(&["title"]), &[]),
            MergeDecision::Clash(_)
        ));
    }

    #[test]
    fn an_unstamped_field_on_a_tracked_record_last_changed_at_the_marker() {
        // Created at 1; someone changed status (2). A writer still at base 1
        // changing priority, which nobody touched, merges.
        let mut s = FieldRevisions::new();
        stamp(&mut s, &touched(&["status"]), 2, Some("usr_a"));
        assert_eq!(s[TRACKED_SINCE].revision, 1);
        assert_eq!(
            decide(2, 1, &s, &touched(&["priority"]), &[]),
            MergeDecision::Apply
        );
        assert!(matches!(
            decide(2, 1, &s, &touched(&["status"]), &[]),
            MergeDecision::Clash(_)
        ));
    }

    #[test]
    fn a_legacy_record_heals_on_its_first_tracked_write() {
        // Moved to 5 before tracking; the first tracked write makes it 6.
        let mut s = FieldRevisions::new();
        stamp(&mut s, &touched(&["title"]), 6, None);
        // A base of 5 saw everything up to the marker, so `body` merges...
        assert_eq!(
            decide(6, 5, &s, &touched(&["body"]), &[]),
            MergeDecision::Apply
        );
        // ...but a base of 3 cannot know whether `body` moved in 4 or 5.
        assert!(matches!(
            decide(6, 3, &s, &touched(&["body"]), &[]),
            MergeDecision::Clash(_)
        ));
    }

    #[test]
    fn impossible_bases_are_refused() {
        assert_eq!(
            decide(3, 4, &stamps(&[]), &touched(&["title"]), &[]),
            MergeDecision::InvalidBase
        );
        assert_eq!(
            decide(3, 0, &stamps(&[]), &touched(&["title"]), &[]),
            MergeDecision::InvalidBase
        );
    }

    #[test]
    fn stamping_records_the_new_revision_and_author() {
        let mut s = FieldRevisions::new();
        stamp(&mut s, &touched(&["title", "body"]), 8, Some("usr_a"));
        assert_eq!(
            s["title"],
            FieldStamp {
                revision: 8,
                by: Some("usr_a".into())
            }
        );
        assert_eq!(s.len(), 3, "two fields plus the tracking marker");
        // The marker is set once and never moves forward.
        stamp(&mut s, &touched(&["title"]), 9, None);
        assert_eq!(s[TRACKED_SINCE].revision, 7);
    }

    #[test]
    fn a_stored_map_round_trips_and_garbage_reads_as_empty() {
        let s = stamps(&[("status", 3)]);
        assert_eq!(parse(&serde_json::to_value(&s).unwrap()), s);
        assert!(parse(&serde_json::json!("nonsense")).is_empty());
    }

    #[test]
    fn the_clash_report_names_both_values_and_who_changed_it() {
        let clash = FieldClash {
            field: "steps.s1".into(),
            changed_at: 4,
            changed_by: Some("usr_b".into()),
        };
        let report = clash_report(
            &[clash],
            &serde_json::json!({ "steps": { "s1": "done" } }),
            &serde_json::json!({ "steps": { "s1": "blocked" } }),
        );
        assert_eq!(
            report,
            serde_json::json!({
                "steps.s1": { "yours": "done", "theirs": "blocked", "changedAt": 4, "changedBy": "usr_b" }
            })
        );
    }
}
