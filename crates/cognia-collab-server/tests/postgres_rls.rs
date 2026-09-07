use cognia_collab_server::{OperatorBootstrap, PgStore};
use tokio_postgres::{Client, NoTls};

const APP_ROLE: &str = "cognia_rls_app";

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL instance"]
async fn shared_chat_claim_is_atomic_and_survives_pool_reconnect() {
    use cognia_collab_server::chat::{SessionRole, SessionStatus};
    use cognia_collab_server::chat_store::{
        ChatStore, NewChatRunLease, NewChatRunQueueItem, NewSessionEvent, NewSharedSession,
    };
    let url = std::env::var("COLLAB_RLS_ADMIN_DATABASE_URL").unwrap();
    let store = PgStore::connect(&url, 4).await.unwrap();
    let scope = bootstrap("shared_queue");
    store.bootstrap_operator(&scope).await.unwrap();
    let mut participant = bootstrap("shared_participant");
    participant.org_id = scope.org_id.clone();
    participant.logto_organization_id = scope.logto_organization_id.clone();
    participant.workspace_id = scope.workspace_id.clone();
    store.bootstrap_operator(&participant).await.unwrap();
    let session_id = format!("session_{}", uuid::Uuid::new_v4());
    store
        .create_session(NewSharedSession {
            id: session_id.clone(),
            org_id: scope.org_id.clone(),
            workspace_id: scope.workspace_id.clone(),
            title: "Queue integration".into(),
            status: SessionStatus::Active,
            created_by_user_id: scope.user_id.clone(),
            now: 1,
            operation_id: session_id.clone(),
        })
        .await
        .unwrap();
    store
        .put_member(
            &scope.org_id,
            &session_id,
            &scope.workspace_id,
            &participant.user_id,
            SessionRole::Member,
            false,
            false,
            2,
        )
        .await
        .unwrap();
    // This executes the qualified-column discovery SQL, not an in-memory stand-in.
    assert!(store
        .list_sessions(&scope.org_id, &scope.user_id, Some(&scope.workspace_id))
        .await
        .unwrap()
        .iter()
        .any(|session| session.id == session_id));
    let event = NewSessionEvent {
        id: format!("event_{session_id}"),
        org_id: scope.org_id.clone(),
        workspace_id: scope.workspace_id.clone(),
        session_id: session_id.clone(),
        kind: "message.created".into(),
        actor_kind: "human".into(),
        actor_id: scope.user_id.clone(),
        actor_label: None,
        payload: serde_json::json!({"messageId":"question","role":"user","parts":[{"type":"text","text":"hello"}]}),
        now: 2,
        operation_id: format!("message_{session_id}"),
    };
    let durable = store.append_session_event(event.clone()).await.unwrap();
    assert_eq!(store.append_session_event(event).await.unwrap(), durable);
    let q1 = format!("q1_{session_id}");
    let q2 = format!("q2_{session_id}");
    for (id, now) in [(&q1, 3), (&q2, 4)] {
        store
            .enqueue_run_input(NewChatRunQueueItem {
                id: id.clone(),
                org_id: scope.org_id.clone(),
                workspace_id: scope.workspace_id.clone(),
                session_id: session_id.clone(),
                requested_by_user_id: if id == &q1 {
                    scope.user_id.clone()
                } else {
                    participant.user_id.clone()
                },
                payload: serde_json::json!({"messageId":"question"}),
                now,
                operation_id: id.clone(),
            })
            .await
            .unwrap();
    }
    let lease = |device: &str| NewChatRunLease {
        id: format!("lease_{device}_{session_id}"),
        org_id: scope.org_id.clone(),
        workspace_id: scope.workspace_id.clone(),
        session_id: session_id.clone(),
        run_id: format!("run_{device}_{session_id}"),
        holder_user_id: scope.user_id.clone(),
        holder_device_id: device.into(),
        token_hash: format!("hash_{device}"),
        token_expires_at: 100,
        heartbeat_expires_at: 100,
        now: 5,
        operation_id: format!("claim_{device}_{session_id}"),
    };
    assert!(store
        .claim_run_queue(lease("later"), &q2, false)
        .await
        .is_err());
    let (first, second) = tokio::join!(
        store.claim_run_queue(lease("desktop"), &q1, false),
        store.claim_run_queue(lease("browser"), &q1, false),
    );
    assert_ne!(
        first.is_ok(),
        second.is_ok(),
        "exactly one device must acquire the writer lease"
    );
    let (winner, item) = first.or(second).unwrap();
    assert_eq!(item.payload["contextSequence"], durable.sequence);
    drop(store);
    let store = PgStore::connect(&url, 2).await.unwrap();
    let replay = store
        .claim_run_queue(lease(&winner.holder_device_id), &q1, false)
        .await
        .unwrap();
    assert_eq!(replay.0, winner);
    let mut takeover = lease("replacement");
    takeover.holder_user_id = participant.user_id.clone();
    takeover.now = 101;
    takeover.token_expires_at = 200;
    takeover.heartbeat_expires_at = 200;
    assert!(store
        .claim_run_queue(takeover.clone(), &q2, false)
        .await
        .is_err());
    let (replacement, requested) = store.claim_run_queue(takeover, &q2, true).await.unwrap();
    assert_eq!(requested.requested_by_user_id, participant.user_id);
    store
        .remove_member(&scope.org_id, &session_id, &participant.user_id, 102)
        .await
        .unwrap();
    assert!(store
        .validate_run_token(
            &scope.org_id,
            &session_id,
            &replacement.run_id,
            "hash_replacement",
            103
        )
        .await
        .is_err());
    let stale = NewSessionEvent {
        id: format!("late_{session_id}"),
        org_id: scope.org_id.clone(),
        workspace_id: scope.workspace_id.clone(),
        session_id: session_id.clone(),
        kind: "message.created".into(),
        actor_kind: "agent".into(),
        actor_id: format!("run:{}", winner.run_id),
        actor_label: None,
        payload: serde_json::json!({"messageId":"late","role":"assistant","parts":[]}),
        now: 102,
        operation_id: format!("late_{session_id}"),
    };
    assert!(store
        .append_session_run_event(
            stale,
            &winner.run_id,
            &format!("hash_{}", winner.holder_device_id)
        )
        .await
        .is_err());
    assert_eq!(
        store
            .list_session_events(&scope.org_id, &session_id, 0, 100)
            .await
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL instance and two database roles"]
async fn force_rls_isolates_reads_and_every_write_across_pool_reuse() {
    let admin_url = std::env::var("COLLAB_RLS_ADMIN_DATABASE_URL")
        .expect("COLLAB_RLS_ADMIN_DATABASE_URL must name the migration/bootstrap role");
    let app_url = std::env::var("COLLAB_RLS_APP_DATABASE_URL")
        .expect("COLLAB_RLS_APP_DATABASE_URL must name a non-BYPASSRLS application role");

    let admin_store = PgStore::connect(&admin_url, 2)
        .await
        .expect("admin migrations must succeed");
    admin_store
        .bootstrap_operator(&bootstrap("a"))
        .await
        .expect("tenant A bootstrap must succeed");
    admin_store
        .bootstrap_operator(&bootstrap("b"))
        .await
        .expect("tenant B bootstrap must succeed");

    let (admin, admin_connection) = tokio_postgres::connect(&admin_url, NoTls)
        .await
        .expect("admin SQL connection must open");
    tokio::spawn(async move {
        admin_connection
            .await
            .expect("admin SQL connection must stay healthy");
    });
    admin
        .batch_execute(&format!(
            "GRANT USAGE ON SCHEMA public TO {APP_ROLE}; \
             GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO {APP_ROLE}; \
             GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO {APP_ROLE};"
        ))
        .await
        .expect("least-privilege grants must succeed");

    let (mut app, app_connection) = tokio_postgres::connect(&app_url, NoTls)
        .await
        .expect("application SQL connection must open");
    tokio::spawn(async move {
        app_connection
            .await
            .expect("application SQL connection must stay healthy");
    });

    let role = app
        .query_one(
            "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
            &[],
        )
        .await
        .expect("application role attributes must be readable");
    assert!(!role.get::<_, bool>(0), "test role must not be superuser");
    assert!(!role.get::<_, bool>(1), "test role must not bypass RLS");

    assert_force_rls(&app).await;
    assert_tenant_read(&mut app, "org_a", "org_a").await;
    assert_tenant_read(&mut app, "org_b", "org_b").await;
    assert_unscoped_connection_is_empty(&mut app).await;
    assert_crud_and_cross_tenant_writes(&mut app).await;
    assert_pool_reuse_clears_tenant(&mut app).await;
    assert_subject_scope_sees_only_its_own_person(&mut app).await;
    assert_invitation_lookup_needs_the_token_hash(&mut app).await;
    assert_bootstrap_writes_pass_every_check_in_order(&mut app).await;
    assert_operation_and_credential_rows_are_owner_only(&mut app).await;
}

// ── Migration 0009: the account control plane ────────────────────────────────
//
// These run as the least-privilege application role, so what they prove is
// that the subject-, token-, operation- and credential-scoped policies expose
// exactly one person's rows and nothing else, with no `app.tenant_id` bound.

/// The two-step bind `PgStore::list_account_memberships` performs: the
/// subject opens its own `external_identities` rows, and the user ids that
/// lookup returns are bound as `app.account_user_ids` for every other policy.
async fn bind_subject(transaction: &tokio_postgres::Transaction<'_>, subject: &str, tenant: &str) {
    for (name, value) in [
        ("app.account_provider", "logto"),
        ("app.account_subject", subject),
        ("app.account_tenant", tenant),
    ] {
        transaction
            .execute("SELECT set_config($1, $2, true)", &[&name, &value])
            .await
            .expect("subject bind must succeed");
    }
    let user_ids: Vec<String> = transaction
        .query(
            "SELECT DISTINCT user_id FROM external_identities ORDER BY user_id",
            &[],
        )
        .await
        .expect("subject lookup must succeed")
        .iter()
        .map(|row| row.get(0))
        .collect();
    transaction
        .execute(
            "SELECT set_config('app.account_user_ids', $1, true)",
            &[&user_ids.join(",")],
        )
        .await
        .expect("user id bind must succeed");
}

async fn assert_subject_scope_sees_only_its_own_person(client: &mut Client) {
    // Subject A across every tenant: exactly A's rows, and only org_a.
    let transaction = client.transaction().await.expect("transaction must start");
    bind_subject(&transaction, "subject_a", "").await;
    let users: Vec<String> = transaction
        .query("SELECT id FROM users ORDER BY id", &[])
        .await
        .expect("subject-scoped users read must succeed")
        .iter()
        .map(|row| row.get(0))
        .collect();
    assert_eq!(users, vec!["usr_a".to_string()]);
    let orgs: Vec<String> = transaction
        .query("SELECT id FROM orgs ORDER BY id", &[])
        .await
        .expect("subject-scoped orgs read must succeed")
        .iter()
        .map(|row| row.get(0))
        .collect();
    assert_eq!(orgs, vec!["org_a".to_string()]);
    let memberships: i64 = transaction
        .query_one("SELECT count(*) FROM org_memberships", &[])
        .await
        .expect("subject-scoped memberships read must succeed")
        .get(0);
    assert_eq!(memberships, 1);
    // Read-only: the subject scope grants no write anywhere.
    let write = transaction
        .execute(
            "UPDATE org_memberships SET role = 'owner' WHERE user_id = 'usr_a'",
            &[],
        )
        .await
        .expect("a subject-scoped update must be invisible, not an error");
    assert_eq!(write, 0);
    transaction.commit().await.expect("transaction must commit");

    // A tenant narrows: subject A asked about tenant B sees nothing.
    let transaction = client.transaction().await.expect("transaction must start");
    bind_subject(&transaction, "subject_a", "logto_org_b").await;
    let count: i64 = transaction
        .query_one("SELECT count(*) FROM users", &[])
        .await
        .expect("narrowed read must succeed")
        .get(0);
    assert_eq!(count, 0);
    transaction.commit().await.expect("transaction must commit");

    // A subject nobody linked sees nothing at all.
    let transaction = client.transaction().await.expect("transaction must start");
    bind_subject(&transaction, "subject_nobody", "").await;
    let count: i64 = transaction
        .query_one("SELECT count(*) FROM orgs", &[])
        .await
        .expect("stranger read must succeed")
        .get(0);
    assert_eq!(count, 0);
    transaction.commit().await.expect("transaction must commit");
}

async fn assert_invitation_lookup_needs_the_token_hash(client: &mut Client) {
    // Mint one invitation inside tenant A, the way the org route does.
    let transaction = client.transaction().await.expect("transaction must start");
    bind_tenant(&transaction, "org_a").await;
    transaction
        .execute(
            "INSERT INTO organization_invitations                (id, org_id, org_role, token_hash, created_by, expires_at, created_at)              VALUES ('inv_rls', 'org_a', 'member', 'hash_rls', 'usr_a', 9999999999999, 1)",
            &[],
        )
        .await
        .expect("same-tenant invitation insert must succeed");
    transaction.commit().await.expect("transaction must commit");

    // With the hash bound and NO tenant, exactly that row is visible.
    let transaction = client.transaction().await.expect("transaction must start");
    transaction
        .execute(
            "SELECT set_config('app.invitation_token_hash', 'hash_rls', true)",
            &[],
        )
        .await
        .expect("hash bind must succeed");
    let rows = transaction
        .query("SELECT id, org_id FROM organization_invitations", &[])
        .await
        .expect("token-scoped read must succeed");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].get::<_, String>(1), "org_a");
    // And it is read-only: redeeming needs the tenant scope.
    let redeemed = transaction
        .execute(
            "UPDATE organization_invitations SET redeemed_at = 5 WHERE id = 'inv_rls'",
            &[],
        )
        .await
        .expect("token-scoped update must be invisible");
    assert_eq!(redeemed, 0);
    transaction.commit().await.expect("transaction must commit");

    // A wrong hash sees nothing.
    let transaction = client.transaction().await.expect("transaction must start");
    transaction
        .execute(
            "SELECT set_config('app.invitation_token_hash', 'hash_other', true)",
            &[],
        )
        .await
        .expect("hash bind must succeed");
    let count: i64 = transaction
        .query_one("SELECT count(*) FROM organization_invitations", &[])
        .await
        .expect("wrong-hash read must succeed")
        .get(0);
    assert_eq!(count, 0);
    transaction.commit().await.expect("transaction must commit");
}

/// The exact statement order `PgStore::bootstrap_account` uses, replayed by
/// the application role under the NEW org's tenant scope: each WITH CHECK
/// must pass because of the row inserted just before it.
async fn assert_bootstrap_writes_pass_every_check_in_order(client: &mut Client) {
    let transaction = client.transaction().await.expect("transaction must start");
    bind_tenant(&transaction, "org_new").await;
    transaction
        .execute(
            "INSERT INTO orgs (id, display_name, logto_organization_id, created_at, updated_at)              VALUES ('org_new', 'New', 'logto_org_new', 1, 1)",
            &[],
        )
        .await
        .expect("the org row passes because its id is the tenant");
    transaction
        .execute(
            "INSERT INTO users (id, display_name, created_at, updated_at)              VALUES ('usr_new', 'Newcomer', 1, 1)",
            &[],
        )
        .await
        .expect("the user row passes because a tenant is bound");
    transaction
        .execute(
            "INSERT INTO org_memberships (org_id, user_id, role, created_at, updated_at)              VALUES ('org_new', 'usr_new', 'owner', 1, 1)",
            &[],
        )
        .await
        .expect("the membership passes because its org is the tenant");
    transaction
        .execute(
            "INSERT INTO external_identities (id, user_id, provider, subject, tenant, linked_at)              VALUES ('ext_new', 'usr_new', 'logto', 'subject_new', 'logto_org_new', 1)",
            &[],
        )
        .await
        .expect("the identity passes because the membership now exists");
    transaction
        .commit()
        .await
        .expect("bootstrap transaction must commit");

    // And the new person is discoverable by subject afterwards.
    let transaction = client.transaction().await.expect("transaction must start");
    bind_subject(&transaction, "subject_new", "").await;
    let orgs: Vec<String> = transaction
        .query("SELECT id FROM orgs", &[])
        .await
        .expect("subject read must succeed")
        .iter()
        .map(|row| row.get(0))
        .collect();
    assert_eq!(orgs, vec!["org_new".to_string()]);
    transaction.commit().await.expect("transaction must commit");
}

async fn assert_operation_and_credential_rows_are_owner_only(client: &mut Client) {
    let transaction = client.transaction().await.expect("transaction must start");
    for (name, value) in [
        ("app.provisioning_operation", "op_rls"),
        ("app.account_provider", "logto"),
        ("app.account_subject", "subject_new"),
    ] {
        transaction
            .execute("SELECT set_config($1, $2, true)", &[&name, &value])
            .await
            .expect("operation bind must succeed");
    }
    transaction
        .execute(
            "INSERT INTO identity_provisioning_operations                (id, kind, state, identity_provider, identity_subject, created_at, updated_at)              VALUES ('op_rls', 'bootstrap', 'pending', 'logto', 'subject_new', 1, 1)",
            &[],
        )
        .await
        .expect("an operation may be written under its own id");
    let other = transaction
        .execute(
            "INSERT INTO identity_provisioning_operations                (id, kind, state, identity_provider, identity_subject, created_at, updated_at)              VALUES ('op_other', 'bootstrap', 'pending', 'logto', 'subject_new', 1, 1)",
            &[],
        )
        .await;
    assert!(other.is_err(), "another operation id must be refused");
    transaction
        .rollback()
        .await
        .expect("failed write transaction must roll back");

    // The right id under the wrong subject is refused too: the policy is
    // keyed on both, so a guessed handle cannot be claimed.
    let transaction = client.transaction().await.expect("transaction must start");
    for (name, value) in [
        ("app.provisioning_operation", "op_rls"),
        ("app.account_provider", "logto"),
        ("app.account_subject", "subject_stranger"),
    ] {
        transaction
            .execute("SELECT set_config($1, $2, true)", &[&name, &value])
            .await
            .expect("operation bind must succeed");
    }
    let stranger = transaction
        .execute(
            "INSERT INTO identity_provisioning_operations \
               (id, kind, state, identity_provider, identity_subject, created_at, updated_at) \
             VALUES ('op_rls', 'bootstrap', 'pending', 'logto', 'subject_new', 1, 1)",
            &[],
        )
        .await;
    assert!(
        stranger.is_err(),
        "another subject must not write under this operation id"
    );
    transaction
        .rollback()
        .await
        .expect("failed write transaction must roll back");

    let transaction = client.transaction().await.expect("transaction must start");
    let count: i64 = transaction
        .query_one("SELECT count(*) FROM deployment_bootstrap_credentials", &[])
        .await
        .expect("unscoped credential read must fail closed")
        .get(0);
    assert_eq!(count, 0);
    transaction.commit().await.expect("transaction must commit");
}

async fn assert_force_rls(client: &Client) {
    let rows = client
        .query(
            "SELECT relname, relrowsecurity, relforcerowsecurity \
             FROM pg_class WHERE relname = ANY($1) ORDER BY relname",
            &[&vec![
                "deployment_bootstrap_credentials",
                "identity_provisioning_operations",
                "issues",
                "issue_events",
                "org_memberships",
                "organization_invitations",
                "workspaces",
                "workspace_memberships",
            ]],
        )
        .await
        .expect("RLS metadata must be readable");
    assert_eq!(rows.len(), 8);
    for row in rows {
        assert!(
            row.get::<_, bool>(1),
            "{} must enable RLS",
            row.get::<_, String>(0)
        );
        assert!(
            row.get::<_, bool>(2),
            "{} must force RLS",
            row.get::<_, String>(0)
        );
    }
}

async fn assert_tenant_read(client: &mut Client, tenant: &str, expected: &str) {
    let transaction = client.transaction().await.expect("transaction must start");
    bind_tenant(&transaction, tenant).await;
    let rows = transaction
        .query("SELECT id FROM orgs ORDER BY id", &[])
        .await
        .expect("tenant org query must succeed");
    assert_eq!(
        rows.iter()
            .map(|row| row.get::<_, String>(0))
            .collect::<Vec<_>>(),
        vec![expected]
    );
    transaction.commit().await.expect("transaction must commit");
}

async fn assert_unscoped_connection_is_empty(client: &mut Client) {
    let transaction = client.transaction().await.expect("transaction must start");
    let count: i64 = transaction
        .query_one("SELECT count(*) FROM orgs", &[])
        .await
        .expect("unscoped read must fail closed")
        .get(0);
    assert_eq!(count, 0);
    transaction.commit().await.expect("transaction must commit");
}

async fn assert_crud_and_cross_tenant_writes(client: &mut Client) {
    let transaction = client.transaction().await.expect("transaction must start");
    bind_tenant(&transaction, "org_a").await;
    transaction
        .execute(
            "INSERT INTO issues (id, org_id, workspace_id, issue_project_id, title, status, \
             priority, created_by_kind, created_by_id, created_at, updated_at, created_operation_id, last_operation_id) \
             VALUES ('issue_rls', 'org_a', 'workspace_a', 'project_a', 'safe', 'open', \
             'medium', 'human', 'usr_a', 10, 10, 'rls_operation', 'rls_operation')",
            &[],
        )
        .await
        .expect("same-tenant insert must succeed");
    assert_eq!(
        transaction
            .execute(
                "UPDATE issues SET title = 'updated' WHERE id = 'issue_rls'",
                &[]
            )
            .await
            .expect("same-tenant update must succeed"),
        1
    );
    assert_eq!(
        transaction
            .execute(
                "UPDATE issues SET title = 'leak' WHERE org_id = 'org_b'",
                &[]
            )
            .await
            .expect("cross-tenant update must be invisible"),
        0
    );
    assert_eq!(
        transaction
            .execute("DELETE FROM issues WHERE org_id = 'org_b'", &[])
            .await
            .expect("cross-tenant delete must be invisible"),
        0
    );
    assert_eq!(
        transaction
            .execute("DELETE FROM issues WHERE id = 'issue_rls'", &[])
            .await
            .expect("same-tenant delete must succeed"),
        1
    );
    transaction.commit().await.expect("transaction must commit");

    let transaction = client.transaction().await.expect("transaction must start");
    bind_tenant(&transaction, "org_a").await;
    let cross_tenant = transaction
        .execute(
            "INSERT INTO issues (id, org_id, workspace_id, issue_project_id, title, status, \
             priority, created_by_kind, created_by_id, created_at, updated_at, created_operation_id, last_operation_id) \
             VALUES ('issue_cross', 'org_b', 'workspace_b', 'project_b', 'blocked', 'open', \
             'medium', 'human', 'usr_b', 10, 10, 'rls_cross_operation', 'rls_cross_operation')",
            &[],
        )
        .await;
    assert!(
        cross_tenant.is_err(),
        "cross-tenant insert must be rejected"
    );
    transaction
        .rollback()
        .await
        .expect("failed write transaction must roll back");

    let transaction = client.transaction().await.expect("transaction must start");
    bind_tenant(&transaction, "org_a").await;
    let mismatched_workspace = transaction
        .execute(
            "INSERT INTO issues (id, org_id, workspace_id, issue_project_id, title, status, \
             priority, created_by_kind, created_by_id, created_at, updated_at, created_operation_id, last_operation_id) \
             VALUES ('issue_fk', 'org_a', 'workspace_b', 'project_a', 'blocked', 'open', \
             'medium', 'human', 'usr_a', 10, 10, 'rls_operation', 'rls_operation')",
            &[],
        )
        .await;
    assert!(
        mismatched_workspace.is_err(),
        "composite tenant FK must reject a foreign workspace"
    );
    transaction
        .rollback()
        .await
        .expect("failed FK transaction must roll back");
}

async fn assert_pool_reuse_clears_tenant(client: &mut Client) {
    let transaction = client.transaction().await.expect("transaction must start");
    bind_tenant(&transaction, "org_a").await;
    let visible: i64 = transaction
        .query_one("SELECT count(*) FROM orgs", &[])
        .await
        .expect("scoped count must succeed")
        .get(0);
    assert_eq!(visible, 1);
    transaction.commit().await.expect("transaction must commit");

    let recycled = client
        .transaction()
        .await
        .expect("recycled transaction must start");
    let visible: i64 = recycled
        .query_one("SELECT count(*) FROM orgs", &[])
        .await
        .expect("recycled connection must be unscoped")
        .get(0);
    assert_eq!(
        visible, 0,
        "SET LOCAL tenant must not leak across pool reuse"
    );
    recycled
        .commit()
        .await
        .expect("recycled transaction must commit");
}

async fn bind_tenant(transaction: &tokio_postgres::Transaction<'_>, tenant: &str) {
    transaction
        .execute("SELECT set_config('app.tenant_id', $1, true)", &[&tenant])
        .await
        .expect("tenant bind must succeed");
}

fn bootstrap(suffix: &str) -> OperatorBootstrap {
    OperatorBootstrap {
        org_id: format!("org_{suffix}"),
        org_name: format!("Org {suffix}"),
        logto_organization_id: format!("logto_org_{suffix}"),
        user_id: format!("usr_{suffix}"),
        user_name: format!("User {suffix}"),
        user_email: Some(format!("{suffix}@example.test")),
        identity_id: format!("ext_{suffix}"),
        identity_provider: "logto".into(),
        identity_subject: format!("subject_{suffix}"),
        workspace_id: format!("workspace_{suffix}"),
        workspace_name: format!("Workspace {suffix}"),
        now: 1,
    }
}
