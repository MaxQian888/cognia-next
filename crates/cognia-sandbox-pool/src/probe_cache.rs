//! What a cached probe records (ADR-0183).
//!
//! A probe answers "can this image host the agent, and as whom" for one user
//! image and one bundle. The driver caches the answer, and a console reads it
//! back. Both sides go through [`ProbeCacheEntry`], so the reader can never
//! drift from the writer: the entry is written in one place and parsed in one
//! place, and an entry that does not parse is reported as unreadable rather
//! than half-read.
//!
//! Besides the report, the entry records the inputs that change it — the
//! target user, whether that user is remapped onto the workspace owner, and
//! who owned the workspace — because a report taken for a different one of
//! those answers a different question.

use serde_json::{json, Value};

// The entry's public fields are these types, so a reader needs them without
// depending on `cognia-sandboxd` itself.
pub use cognia_sandboxd::layout::{Arch, Libc};
pub use cognia_sandboxd::passwd::{ResolvedUser, UserSpec};
pub use cognia_sandboxd::probe::{
    Ownership, ProbeCode, ProbeProblem, ProbeReport, PROBE_REPORT_VERSION,
};

/// Bump when the shape of a cached probe entry changes; an older entry is then
/// ignored rather than misread.
pub const PROBE_CACHE_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProbeCacheEntry {
    pub version: u32,
    /// The target user the probe was asked about, as `UserSpec` prints it.
    pub user: String,
    pub match_workspace_owner: bool,
    pub workspace_owner: Option<Ownership>,
    pub report: ProbeReport,
}

impl ProbeCacheEntry {
    pub fn new(
        user: &UserSpec,
        match_workspace_owner: bool,
        workspace_owner: Option<Ownership>,
        report: ProbeReport,
    ) -> Self {
        Self {
            version: PROBE_CACHE_VERSION,
            user: user.to_string(),
            match_workspace_owner,
            workspace_owner,
            report,
        }
    }

    /// The stored form. `workspaceOwner` is written as `null` when there is
    /// none, so an entry always carries every key.
    pub fn to_value(&self) -> Value {
        json!({
            "version": self.version,
            "user": self.user,
            "matchWorkspaceOwner": self.match_workspace_owner,
            "workspaceOwner": self.workspace_owner.map(|owner| json!({
                "uid": owner.uid,
                "gid": owner.gid,
            })),
            "report": self.report,
        })
    }

    /// The entry `value` stores, or `None` when this build cannot read it —
    /// another version, a missing key, or a report of another shape.
    pub fn from_value(value: &Value) -> Option<Self> {
        let version = u32::try_from(value.get("version")?.as_u64()?).ok()?;
        if version != PROBE_CACHE_VERSION {
            return None;
        }
        let workspace_owner = match value.get("workspaceOwner") {
            None | Some(Value::Null) => None,
            Some(owner) => Some(serde_json::from_value::<Ownership>(owner.clone()).ok()?),
        };
        Some(Self {
            version,
            user: value.get("user")?.as_str()?.to_string(),
            match_workspace_owner: value.get("matchWorkspaceOwner")?.as_bool()?,
            workspace_owner,
            report: serde_json::from_value(value.get("report")?.clone()).ok()?,
        })
    }

    /// The report, when this entry answers exactly the question asked.
    pub fn report_for(
        &self,
        user: &UserSpec,
        match_workspace_owner: bool,
        workspace_owner: Option<Ownership>,
    ) -> Option<&ProbeReport> {
        (self.user == user.to_string()
            && self.match_workspace_owner == match_workspace_owner
            && self.workspace_owner == workspace_owner)
            .then_some(&self.report)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report(problems: Vec<ProbeProblem>) -> ProbeReport {
        ProbeReport {
            version: PROBE_REPORT_VERSION,
            arch: Arch::Arm64,
            libc: Some(Libc::Musl),
            glibc_version: None,
            interpreter: Some("/lib/ld-musl-aarch64.so.1".to_string()),
            shell: Some("/bin/busybox".to_string()),
            user: None,
            user_remapped_from: None,
            workspace_owner: None,
            home_writable: None,
            workspace_writable: true,
            ca_bundle: None,
            runtimes: vec!["codex-acp".to_string()],
            commands: Vec::new(),
            problems,
        }
    }

    const OWNER: Ownership = Ownership {
        uid: 1000,
        gid: 1001,
    };

    #[test]
    fn an_entry_reads_back_as_it_was_written() {
        let entry =
            ProbeCacheEntry::new(&UserSpec::Uid(10001), true, Some(OWNER), report(Vec::new()));
        let stored = entry.to_value();
        assert_eq!(
            stored["workspaceOwner"],
            json!({ "uid": 1000, "gid": 1001 })
        );
        assert_eq!(ProbeCacheEntry::from_value(&stored), Some(entry));
    }

    // The failure is the part a console must not lose: a report that refused
    // the image reads back with its problems.
    #[test]
    fn a_refusing_report_keeps_its_problems() {
        let problem = ProbeProblem {
            code: ProbeCode::LibcUnsupported,
            message: "no C library".to_string(),
        };
        let entry = ProbeCacheEntry::new(
            &UserSpec::Uid(0),
            false,
            None,
            report(vec![problem.clone()]),
        );
        let stored = entry.to_value();
        assert_eq!(stored["workspaceOwner"], Value::Null);
        let read = ProbeCacheEntry::from_value(&stored).expect("readable");
        assert_eq!(read.report.problems, vec![problem]);
        assert_eq!(read.workspace_owner, None);
    }

    #[test]
    fn an_entry_of_another_version_or_shape_is_unreadable() {
        let stored =
            ProbeCacheEntry::new(&UserSpec::Uid(0), false, None, report(Vec::new())).to_value();

        let mut newer = stored.clone();
        newer["version"] = json!(PROBE_CACHE_VERSION + 1);
        assert_eq!(ProbeCacheEntry::from_value(&newer), None);

        let mut numeric_owner = stored.clone();
        numeric_owner["workspaceOwner"] = json!(1000);
        assert_eq!(ProbeCacheEntry::from_value(&numeric_owner), None);

        let mut no_report = stored.clone();
        no_report.as_object_mut().unwrap().remove("report");
        assert_eq!(ProbeCacheEntry::from_value(&no_report), None);

        assert_eq!(ProbeCacheEntry::from_value(&json!({ "version": 1 })), None);
    }

    #[test]
    fn a_report_answers_only_the_question_it_was_taken_for() {
        let user = UserSpec::Name("vscode".to_string());
        let entry = ProbeCacheEntry::new(&user, true, Some(OWNER), report(Vec::new()));

        assert!(entry.report_for(&user, true, Some(OWNER)).is_some());
        assert!(entry
            .report_for(&UserSpec::Uid(10001), true, Some(OWNER))
            .is_none());
        assert!(entry.report_for(&user, false, Some(OWNER)).is_none());
        assert!(entry.report_for(&user, true, None).is_none());
        assert!(entry
            .report_for(&user, true, Some(Ownership { uid: 1, gid: 1 }))
            .is_none());
    }
}
