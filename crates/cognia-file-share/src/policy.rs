//! The effective file-sharing policy, as the host enforces it (ADR-0222 §9.1).
//!
//! TS computes the effective policy (local settings ∩ the org's, fail-closed
//! when the org's cannot be read — `lib/filespace/policy.ts`) and pushes it
//! here; the host stamps each change with a revision and persists it, so a
//! restart keeps the last policy rather than reverting to a looser default.
//! Until anything is pushed the host uses [`PolicySnapshot::default`], whose
//! network-drive switch is off: no credential grant is created or served
//! before the app has said it may be.
//!
//! The gateway re-checks the snapshot on every operation, so tightening it
//! takes effect at once; maintenance then suspends the grants that exceed it
//! (reason `policy`) and resumes them if it loosens again.

use serde::{Deserialize, Serialize};
use schemars::JsonSchema;

use crate::error::{FileShareError, FileShareResult};
use crate::model::{Audience, CreatedBy, Grant, Permission};

/// Shortest live grant accepted.
pub const MIN_LIVE_TTL_SECONDS: i64 = 60;
/// Longest live grant any policy can allow.
pub const MAX_LIVE_TTL_SECONDS: i64 = 365 * 24 * 60 * 60;

/// The settings key the snapshot is stored under.
pub const SETTINGS_KEY: &str = "policy";

/// The policy fields, as pushed (`FileSharingPolicy` in TS).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PolicyFields {
    pub allow_public_snapshots: bool,
    pub allow_live_grants: bool,
    pub allow_protocol_credentials: bool,
    pub allow_live_write: bool,
    pub allow_agent_sharing: bool,
    pub max_snapshot_ttl_seconds: i64,
    pub max_live_ttl_seconds: i64,
}

impl Default for PolicyFields {
    /// `DEFAULT_FILE_SHARING_POLICY` in `lib/filespace/policy.ts`.
    fn default() -> Self {
        Self {
            allow_public_snapshots: true,
            allow_live_grants: true,
            allow_protocol_credentials: false,
            allow_live_write: false,
            allow_agent_sharing: false,
            max_snapshot_ttl_seconds: 30 * 24 * 60 * 60,
            max_live_ttl_seconds: 7 * 24 * 60 * 60,
        }
    }
}

/// The stored policy with the host's revision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PolicySnapshot {
    #[serde(flatten)]
    pub fields: PolicyFields,
    /// The org whose policy was intersected in, when any.
    pub org_id: Option<String>,
    /// That org policy's revision on the plane.
    pub org_revision: Option<i64>,
    /// Bumped by the host on every change; 0 until something is pushed.
    pub revision: i64,
    pub updated_at: i64,
}

/// What TS pushes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyPush {
    pub policy: PolicyFields,
    #[serde(default)]
    pub org_id: Option<String>,
    #[serde(default)]
    pub org_revision: Option<i64>,
}

impl PolicySnapshot {
    /// The snapshot after applying `push`, or `None` when nothing changed.
    pub fn apply(&self, push: PolicyPush, now: i64) -> Option<PolicySnapshot> {
        let mut fields = push.policy;
        // Same coupling as `resolveLocalFileSharingPolicy`: write and
        // credentials mean nothing without live access.
        if !fields.allow_live_grants {
            fields.allow_protocol_credentials = false;
            fields.allow_live_write = false;
        }
        fields.max_live_ttl_seconds = fields
            .max_live_ttl_seconds
            .clamp(MIN_LIVE_TTL_SECONDS, MAX_LIVE_TTL_SECONDS);
        if fields == self.fields
            && push.org_id == self.org_id
            && push.org_revision == self.org_revision
        {
            return None;
        }
        Some(PolicySnapshot {
            fields,
            org_id: push.org_id,
            org_revision: push.org_revision,
            revision: self.revision + 1,
            updated_at: now,
        })
    }

    /// Why a new grant with these terms is refused, or `Ok`. Only a
    /// credential audience needs network-drive credentials allowed; a
    /// collaboration audience is live access without them.
    pub fn check_create(
        &self,
        created_by: CreatedBy,
        credentials: bool,
        permissions: &[Permission],
        ttl_seconds: i64,
    ) -> FileShareResult<()> {
        let fields = &self.fields;
        if created_by == CreatedBy::Agent && !fields.allow_agent_sharing {
            return Err(FileShareError::new(
                "policy_agent_disabled",
                "agents may not share files under the file-sharing policy",
            ));
        }
        if !fields.allow_live_grants {
            return Err(FileShareError::new(
                "policy_live_disabled",
                "live file access is turned off by the file-sharing policy",
            ));
        }
        if credentials && !fields.allow_protocol_credentials {
            return Err(FileShareError::new(
                "policy_credentials_disabled",
                "network-drive credentials are turned off by the file-sharing policy",
            ));
        }
        if permissions.contains(&Permission::Write) && !fields.allow_live_write {
            return Err(FileShareError::new(
                "policy_write_disabled",
                "write access is turned off by the file-sharing policy",
            ));
        }
        if !(MIN_LIVE_TTL_SECONDS..=fields.max_live_ttl_seconds).contains(&ttl_seconds) {
            return Err(FileShareError::new(
                "ttl_exceeds_policy",
                format!(
                    "a live grant may last between {MIN_LIVE_TTL_SECONDS} and {} seconds",
                    fields.max_live_ttl_seconds
                ),
            ));
        }
        Ok(())
    }

    /// Why an existing grant may not be served under this policy, or `None`.
    pub fn exceeded_by(&self, grant: &Grant) -> Option<&'static str> {
        let fields = &self.fields;
        if grant.created_by == CreatedBy::Agent && !fields.allow_agent_sharing {
            return Some("agent_sharing_disabled");
        }
        if !fields.allow_live_grants {
            return Some("live_disabled");
        }
        if grant.audience == Audience::Credentials && !fields.allow_protocol_credentials {
            return Some("credentials_disabled");
        }
        if grant.allows(Permission::Write) && !fields.allow_live_write {
            return Some("write_disabled");
        }
        let lifetime_seconds = (grant.expires_at - grant.created_at) / 1000;
        if lifetime_seconds > fields.max_live_ttl_seconds {
            return Some("ttl");
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::tests::sample_grant;

    fn open() -> PolicyFields {
        PolicyFields {
            allow_protocol_credentials: true,
            allow_live_write: true,
            ..PolicyFields::default()
        }
    }

    #[test]
    fn nothing_pushed_means_no_credential_grants() {
        let snapshot = PolicySnapshot::default();
        assert_eq!(snapshot.revision, 0);
        let error = snapshot
            .check_create(CreatedBy::User, true, &[Permission::Read], 3600)
            .unwrap_err();
        assert_eq!(error.code, "policy_credentials_disabled");
    }

    #[test]
    fn a_push_bumps_the_revision_only_when_something_changed() {
        let first = PolicySnapshot::default()
            .apply(
                PolicyPush {
                    policy: open(),
                    org_id: None,
                    org_revision: None,
                },
                10,
            )
            .unwrap();
        assert_eq!(first.revision, 1);
        assert_eq!(first.updated_at, 10);
        assert!(first
            .apply(
                PolicyPush {
                    policy: open(),
                    org_id: None,
                    org_revision: None
                },
                20
            )
            .is_none());
        let org = first
            .apply(
                PolicyPush {
                    policy: open(),
                    org_id: Some("org_1".into()),
                    org_revision: Some(4),
                },
                30,
            )
            .unwrap();
        assert_eq!(org.revision, 2);
    }

    #[test]
    fn live_off_turns_credentials_and_write_off_and_ttls_are_clamped() {
        let snapshot = PolicySnapshot::default()
            .apply(
                PolicyPush {
                    policy: PolicyFields {
                        allow_live_grants: false,
                        max_live_ttl_seconds: 10 * MAX_LIVE_TTL_SECONDS,
                        ..open()
                    },
                    org_id: None,
                    org_revision: None,
                },
                1,
            )
            .unwrap();
        assert!(!snapshot.fields.allow_protocol_credentials);
        assert!(!snapshot.fields.allow_live_write);
        assert_eq!(snapshot.fields.max_live_ttl_seconds, MAX_LIVE_TTL_SECONDS);
    }

    #[test]
    fn create_checks_name_the_first_refusal() {
        let snapshot = PolicySnapshot {
            fields: open(),
            revision: 1,
            ..PolicySnapshot::default()
        };
        assert!(snapshot.check_create(CreatedBy::User, true, &[Permission::Read], 3600).is_ok());
        assert_eq!(
            snapshot
                .check_create(CreatedBy::User, true, &[Permission::Read], 30)
                .unwrap_err()
                .code,
            "ttl_exceeds_policy"
        );
        assert_eq!(
            snapshot
                .check_create(CreatedBy::User, true, &[Permission::Read], 8 * 24 * 3600)
                .unwrap_err()
                .code,
            "ttl_exceeds_policy"
        );
        let read_only = PolicySnapshot {
            fields: PolicyFields {
                allow_live_write: false,
                ..open()
            },
            ..snapshot.clone()
        };
        assert_eq!(
            read_only
                .check_create(CreatedBy::User, true, &[Permission::Read, Permission::Write], 3600)
                .unwrap_err()
                .code,
            "policy_write_disabled"
        );
        let off = PolicySnapshot {
            fields: PolicyFields {
                allow_live_grants: false,
                ..open()
            },
            ..snapshot
        };
        assert_eq!(
            off.check_create(CreatedBy::User, true, &[Permission::Read], 3600).unwrap_err().code,
            "policy_live_disabled"
        );
    }

    #[test]
    fn an_agent_grant_needs_agent_sharing_at_creation_and_while_it_lives() {
        let allowed = PolicySnapshot {
            fields: PolicyFields {
                allow_agent_sharing: true,
                ..open()
            },
            revision: 1,
            ..PolicySnapshot::default()
        };
        assert!(allowed.check_create(CreatedBy::Agent, true, &[Permission::Read], 3600).is_ok());
        let refused = PolicySnapshot {
            fields: open(),
            ..allowed.clone()
        };
        assert_eq!(
            refused.check_create(CreatedBy::Agent, true, &[Permission::Read], 3600).unwrap_err().code,
            "policy_agent_disabled"
        );
        // The person's own grants are not the agent's.
        assert!(refused.check_create(CreatedBy::User, true, &[Permission::Read], 3600).is_ok());

        let mut grant = sample_grant("fg_1", "s1");
        grant.created_at = 0;
        grant.expires_at = 3600 * 1000;
        grant.created_by = CreatedBy::Agent;
        assert_eq!(allowed.exceeded_by(&grant), None);
        assert_eq!(refused.exceeded_by(&grant), Some("agent_sharing_disabled"));
    }

    #[test]
    fn existing_grants_are_measured_against_the_current_policy() {
        let mut grant = sample_grant("fg_1", "s1");
        grant.created_at = 0;
        grant.expires_at = 3600 * 1000;
        let snapshot = PolicySnapshot {
            fields: open(),
            revision: 1,
            ..PolicySnapshot::default()
        };
        assert_eq!(snapshot.exceeded_by(&grant), None);
        grant.permissions.push(Permission::Write);
        let read_only = PolicySnapshot {
            fields: PolicyFields {
                allow_live_write: false,
                ..open()
            },
            ..snapshot.clone()
        };
        assert_eq!(read_only.exceeded_by(&grant), Some("write_disabled"));
        let short = PolicySnapshot {
            fields: PolicyFields {
                max_live_ttl_seconds: 600,
                ..open()
            },
            ..snapshot.clone()
        };
        assert_eq!(short.exceeded_by(&grant), Some("ttl"));
        assert_eq!(
            PolicySnapshot::default().exceeded_by(&grant),
            Some("credentials_disabled")
        );
    }

    #[test]
    fn members_need_live_access_but_not_network_drive_credentials() {
        let members_only = PolicySnapshot {
            fields: PolicyFields {
                allow_protocol_credentials: false,
                ..open()
            },
            revision: 1,
            ..PolicySnapshot::default()
        };
        assert!(members_only
            .check_create(CreatedBy::User, false, &[Permission::Read], 3600)
            .is_ok());
        assert_eq!(
            members_only
                .check_create(CreatedBy::User, true, &[Permission::Read], 3600)
                .unwrap_err()
                .code,
            "policy_credentials_disabled"
        );
        let mut grant = sample_grant("fg_1", "s1");
        grant.created_at = 0;
        grant.expires_at = 3600 * 1000;
        grant.protocols.clear();
        grant.audience = Audience::Collab {
            org_id: "org_1".into(),
            collab_session_id: "ses_1".into(),
            user_ids: None,
            min_role: crate::model::CollabRole::Viewer,
        };
        assert_eq!(members_only.exceeded_by(&grant), None);
        let off = PolicySnapshot {
            fields: PolicyFields {
                allow_live_grants: false,
                ..open()
            },
            ..members_only
        };
        assert_eq!(off.exceeded_by(&grant), Some("live_disabled"));
        assert_eq!(
            off.check_create(CreatedBy::User, false, &[Permission::Read], 3600).unwrap_err().code,
            "policy_live_disabled"
        );
    }
}
