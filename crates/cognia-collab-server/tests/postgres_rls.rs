use cognia_collab_server::{OperatorBootstrap, PgStore};
use cognia_collab_server::store::{PgConnectOptions, Store};
use tokio_postgres::{Client, NoTls};

struct TestDatabase {
    name: String,
    url: String,
    cluster_admin: Client,
    connection_task: tokio::task::JoinHandle<()>,
}

impl TestDatabase {
    async fn create() -> Self {
        let url = std::env::var("COLLAB_RLS_ADMIN_DATABASE_URL").unwrap();
        let (cluster_admin, connection) = tokio_postgres::connect(&url, NoTls).await.unwrap();
        let connection_task = tokio::spawn(async move { connection.await.unwrap() });
        let name = format!("rls_test_{}", uuid::Uuid::new_v4().simple());
        cluster_admin
            .batch_execute(&format!("CREATE DATABASE {name}"))
            .await
            .unwrap();
        Self {
            url: Self::url_for(&url, &name),
            name,
            cluster_admin,
            connection_task,
        }
    }

    fn url_for(url: &str, database: &str) -> String {
        let separator = if url.contains('?') { '&' } else { '?' };
        format!("{url}{separator}dbname={database}&application_name={database}")
    }

    async fn cleanup(self) {
        self.cleanup_with_role(None).await;
    }

    async fn cleanup_with_role(self, role: Option<&str>) {
        self.cluster_admin
            .batch_execute(&format!("DROP DATABASE {} WITH (FORCE)", self.name))
            .await
            .unwrap();
        if let Some(role) = role {
            self.cluster_admin
                .batch_execute(&format!("DROP ROLE \"{}\"", role.replace('"', "\"\"")))
                .await.unwrap();
        }
        drop(self.cluster_admin);
        self.connection_task.await.unwrap();
    }
}

#[test]
fn isolated_database_url_preserves_each_roles_connection_options() {
    for url in [
        "postgresql://admin:synthetic@localhost:5433/postgres",
        "postgresql://cognia_rls_app:synthetic@localhost:5433/postgres?sslmode=disable",
    ] {
        let original: tokio_postgres::Config = url.parse().unwrap();
        let isolated: tokio_postgres::Config =
            TestDatabase::url_for(url, "scenario_db").parse().unwrap();
        assert_eq!(isolated.get_dbname(), Some("scenario_db"));
        assert_eq!(isolated.get_application_name(), Some("scenario_db"));
        assert_eq!(isolated.get_user(), original.get_user());
        assert_eq!(isolated.get_password(), original.get_password());
        assert_eq!(isolated.get_hosts(), original.get_hosts());
        assert_eq!(isolated.get_ports(), original.get_ports());
        assert_eq!(isolated.get_ssl_mode(), original.get_ssl_mode());
    }
}

async fn health_rls(store: PgStore) -> serde_json::Value {
    use std::{sync::Arc, time::Duration};
    use axum::{body::{to_bytes, Body}, http::Request};
    use cognia_collab_server::{router, AppState};
    use cognia_tenant_auth::{grant::GrantSigner, oidc::{OidcAuthenticator, OidcConfig}};
    use tower::ServiceExt;

    let oidc = OidcAuthenticator::new(OidcConfig {
        issuer: "https://issuer.invalid/oidc".into(),
        audience: "collab".into(),
        tenant_claim: "organization_id".into(),
        jwks_ttl: Duration::from_secs(300),
    }).unwrap();
    let state = AppState::new(Arc::new(store), GrantSigner::new(&[7; 32]).unwrap(), Arc::new(oidc));
    let response = router(state).oneshot(Request::builder().uri("/health").body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(response.status(), axum::http::StatusCode::OK);
    serde_json::from_slice(&to_bytes(response.into_body(), 16_384).await.unwrap()).unwrap()
}

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL instance with a superuser admin URL"]
async fn privileged_app_url_is_refused_and_explicit_override_reports_bypassed() {
    let database = TestDatabase::create().await;
    let result = PgStore::connect(&database.url, 2).await;
    let error = result.err().expect("superuser app URL must be refused").to_string();
    assert!(error.contains("COLLAB_MIGRATION_DATABASE_URL"), "{error}");
    assert!(error.contains("COLLAB_ALLOW_PRIVILEGED_DB_ROLE=true"), "{error}");
    let store = PgStore::connect_with_options(&database.url, 2, PgConnectOptions {
        allow_privileged_db_role: true,
        ..PgConnectOptions::default()
    }).await.unwrap();
    assert_eq!(health_rls(store).await["rls"], "bypassed");
    database.cleanup().await;
}

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL instance with role creation privileges"]
async fn migrator_provisions_missing_app_role_and_preserves_it_on_reboot() {
    let database = TestDatabase::create().await;
    // Exercise server-side SQL quoting of an identifier and a password literal.
    let role = format!("app_{}\"quoted", uuid::Uuid::new_v4().simple());
    let password = "synthetic'password";
    let app_url = format!("{}&user={}&password=synthetic%27password", database.url, role.replace('"', "%22"));
    let missing_password = PgStore::connect_with_options(&app_url, 2, PgConnectOptions {
        migration_database_url: Some(&database.url),
        app_db_role: Some(&role),
        ..PgConnectOptions::default()
    }).await.err().expect("creating a missing role requires its password");
    assert!(missing_password.to_string().contains("COLLAB_APP_DB_PASSWORD"));
    let store = PgStore::connect_with_options(&app_url, 2, PgConnectOptions {
        migration_database_url: Some(&database.url),
        app_db_role: Some(&role),
        app_db_password: Some(password),
        ..PgConnectOptions::default()
    }).await.unwrap();
    assert_eq!(health_rls(store).await["rls"], "enforced");

    let (admin, connection) = tokio_postgres::connect(&database.url, NoTls).await.unwrap();
    let task = tokio::spawn(async move { connection.await.unwrap() });
    let attributes = admin.query_one(
        "SELECT rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = $1", &[&role],
    ).await.unwrap();
    assert!(attributes.get::<_, bool>(0));
    for index in 1..5 { assert!(!attributes.get::<_, bool>(index)); }
    // Objects created after boot inherit the same least-privilege grants.
    admin.batch_execute(
        "CREATE TABLE public.future_grants (id bigint); \
         CREATE SEQUENCE public.future_sequence; \
         CREATE FUNCTION public.future_function() RETURNS integer LANGUAGE sql AS 'SELECT 1'; \
         REVOKE EXECUTE ON FUNCTION public.future_function() FROM PUBLIC;"
    ).await.unwrap();
    let (app, connection) = tokio_postgres::connect(&app_url, NoTls).await.unwrap();
    let app_task = tokio::spawn(async move { connection.await.unwrap() });
    let privileges = app.query_one(
        "SELECT has_schema_privilege('public', 'USAGE'), \
         (SELECT bool_and(has_table_privilege('users', privilege)) \
          FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) AS privilege), \
         (SELECT bool_and(has_table_privilege('future_grants', privilege)) \
          FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) AS privilege), \
         (SELECT bool_and(has_sequence_privilege('future_sequence', privilege)) \
          FROM unnest(ARRAY['USAGE','SELECT']) AS privilege), \
         has_function_privilege('future_function()', 'EXECUTE'), \
         has_table_privilege('future_grants', 'TRUNCATE')", &[],
    ).await.unwrap();
    for index in 0..5 { assert!(privileges.get::<_, bool>(index)); }
    assert!(!privileges.get::<_, bool>(5));
    app.batch_execute("INSERT INTO future_grants VALUES (1); UPDATE future_grants SET id = 2; SELECT * FROM future_grants; DELETE FROM future_grants; SELECT nextval('future_sequence'); SELECT future_function();").await.unwrap();
    drop(app);
    app_task.await.unwrap();
    // No explicit role name: current_user is resolved from the app connection.
    // A supplied replacement password must not rotate an existing login.
    let store = PgStore::connect_with_options(&app_url, 2, PgConnectOptions {
        migration_database_url: Some(&database.url),
        app_db_password: Some("must-not-rotate"),
        ..PgConnectOptions::default()
    }).await.unwrap();
    assert_eq!(health_rls(store).await["rls"], "enforced");
    assert!(PgStore::connect_operator(&app_url, 2).await.is_err());
    drop(admin);
    task.await.unwrap();
    database.cleanup_with_role(Some(&role)).await;
}

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL instance"]
async fn concurrent_bootstrap_waits_for_migration_lock_and_completes() {
    use std::time::Duration;

    let database = TestDatabase::create().await;
    let isolated_url = database.url.clone();
    let (admin, connection) = tokio_postgres::connect(&isolated_url, NoTls).await.unwrap();
    let connection_task = tokio::spawn(async move { connection.await.unwrap() });
    admin
        .batch_execute("SELECT pg_advisory_lock(hashtextextended('cognia.collab.migrations', 0))")
        .await
        .unwrap();
    let first_url = isolated_url.clone();
    let first = tokio::spawn(async move { PgStore::connect_admin(&first_url, 2).await });
    let second = tokio::spawn(async move { PgStore::connect_admin(&isolated_url, 2).await });

    // Observe both connections waiting at the migration barrier, rather than
    // relying on scheduler timing to reproduce a catalog-write collision.
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let waiting: i64 = admin
                .query_one(
                    "SELECT count(*) FROM pg_stat_activity \
                     WHERE application_name = $1 AND wait_event = 'advisory'",
                    &[&database.name],
                )
                .await
                .unwrap()
                .get(0);
            if waiting == 2 {
                break;
            }
            assert!(!first.is_finished() && !second.is_finished());
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("both bootstrap connections must wait for the migration lock");

    admin
        .batch_execute("SELECT pg_advisory_unlock(hashtextextended('cognia.collab.migrations', 0))")
        .await
        .unwrap();
    let (first, second) = tokio::time::timeout(Duration::from_secs(20), async {
        tokio::join!(first, second)
    })
    .await
    .expect("both serialized migrations must finish");
    let first = first.unwrap().expect("first bootstrap succeeds");
    let second = second.unwrap().expect("second bootstrap succeeds");
    let exists: bool = admin
        .query_one("SELECT to_regclass('public.users') IS NOT NULL", &[])
        .await
        .unwrap()
        .get(0);
    assert!(exists, "the schema is committed after bootstrap");
    drop((first, second));
    drop(admin);
    connection_task.await.unwrap();
    database.cleanup().await;
}

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL instance"]
async fn shared_chat_claim_is_atomic_and_survives_pool_reconnect() {
    use cognia_collab_server::chat::{SessionRole, SessionStatus};
    use cognia_collab_server::chat_store::{
        ChatStore, NewChatRunLease, NewChatRunQueueItem, NewSessionEvent, NewSharedSession,
    };
    // A different integration test is free to migrate/bootstrap concurrently;
    // its DDL must not contend with this scenario's lease transactions.
    let database = TestDatabase::create().await;
    let url = database.url.clone();
    let store = PgStore::connect_admin(&url, 4).await.unwrap();
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
            &scope.user_id,
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
    let store = PgStore::connect_admin(&url, 2).await.unwrap();
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
        .remove_member(&scope.org_id, &session_id, &participant.user_id, &scope.user_id, 102)
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
    drop(store);
    database.cleanup().await;
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL instance and two database roles"]
async fn force_rls_isolates_reads_and_every_write_across_pool_reuse() {
    let database = TestDatabase::create().await;
    let admin_url = database.url.clone();
    let app_url = std::env::var("COLLAB_RLS_APP_DATABASE_URL")
        .expect("COLLAB_RLS_APP_DATABASE_URL must name a non-BYPASSRLS application role");
    let app_url = TestDatabase::url_for(&app_url, &database.name);

    let admin_store = PgStore::connect_admin(&admin_url, 2)
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
    let admin_task = tokio::spawn(async move {
        admin_connection
            .await
            .expect("admin SQL connection must stay healthy");
    });
    // Exercise the production migrator's grants, including default privileges.
    let app_store = PgStore::connect_with_options(&app_url, 2, PgConnectOptions {
        migration_database_url: Some(&admin_url),
        ..PgConnectOptions::default()
    }).await.expect("least-privilege application boot must succeed");
    assert_eq!(app_store.rls_status(), cognia_collab_server::store::RlsStatus::Enforced);
    drop(app_store);

    let (mut app, app_connection) = tokio_postgres::connect(&app_url, NoTls)
        .await
        .expect("application SQL connection must open");
    let app_task = tokio::spawn(async move {
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
    drop((app, admin, admin_store));
    app_task.await.unwrap();
    admin_task.await.unwrap();
    database.cleanup().await;
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
                "collab_notification_cursors",
                "collab_notifications",
                "deployment_bootstrap_credentials",
                "identity_provisioning_operations",
                "issues",
                "issue_events",
                "org_memberships",
                "organization_invitations",
                "org_file_sharing_policies",
                "host_file_requests",
                "session_file_grants",
                "session_file_hosts",
                "workspaces",
                "workspace_memberships",
            ]],
        )
        .await
        .expect("RLS metadata must be readable");
    assert_eq!(rows.len(), 14);
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

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL instance"]
async fn stale_patches_merge_by_field_in_postgres() {
    use cognia_collab_server::model::{ActorKind, CollabActor, IssuePriority, IssueStatus};
    use cognia_collab_server::store::{IssuePatch, MutationGuard, NewIssue, StoreError};
    use cognia_collab_server::Store;

    let database = TestDatabase::create().await;
    let store = PgStore::connect_admin(&database.url, 2).await.unwrap();
    let scope = bootstrap("field_merge");
    store.bootstrap_operator(&scope).await.unwrap();
    let id = format!("iss_{}", uuid::Uuid::new_v4().simple());
    store
        .create_issue(NewIssue {
            id: id.clone(),
            org_id: scope.org_id.clone(),
            workspace_id: scope.workspace_id.clone(),
            issue_project_id: "cont-1".into(),
            title: "Ship it".into(),
            body: None,
            status: IssueStatus::Todo,
            priority: IssuePriority::Medium,
            board_order: 1.0,
            assignee: None,
            created_by: CollabActor::new(ActorKind::Human, scope.user_id.clone(), None).unwrap(),
            now: 1,
            operation_id: format!("create-{id}"),
        })
        .await
        .unwrap();
    let guard = |op: &str, base: i64| MutationGuard {
        operation_id: op.into(),
        base_revision: base,
        author: Some(scope.user_id.clone()),
    };

    store
        .patch_issue(
            &scope.org_id,
            &id,
            IssuePatch {
                status: Some(IssueStatus::InProgress),
                ..Default::default()
            },
            guard("first", 1),
            2,
        )
        .await
        .unwrap();
    // Same stale base, a different field: merges through the jsonb stamps.
    let merged = store
        .patch_issue(
            &scope.org_id,
            &id,
            IssuePatch {
                priority: Some(IssuePriority::High),
                ..Default::default()
            },
            guard("second", 1),
            3,
        )
        .await
        .unwrap();
    assert_eq!(merged.status, IssueStatus::InProgress);
    assert_eq!(merged.priority, IssuePriority::High);
    assert_eq!(merged.revision, 3);
    // Same stale base, the same field: a named clash with its author.
    match store
        .patch_issue(
            &scope.org_id,
            &id,
            IssuePatch {
                status: Some(IssueStatus::Done),
                ..Default::default()
            },
            guard("third", 1),
            4,
        )
        .await
    {
        Err(StoreError::FieldConflict { fields, .. }) => {
            assert_eq!(fields["status"]["changedAt"], 2);
            assert_eq!(fields["status"]["changedBy"], scope.user_id.as_str());
        }
        other => panic!("expected a field conflict, got {other:?}"),
    }
    drop(store);
    database.cleanup().await;
}

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL instance"]
async fn notifications_are_per_recipient_ordered_and_deduplicated_in_postgres() {
    use cognia_collab_server::notifications::{
        NewNotification, NotificationKind, NotificationStore, NotificationSubject, ReadCursor,
        ReadSelector, READ_RETENTION_MS,
    };

    let database = TestDatabase::create().await;
    let store = PgStore::connect_admin(&database.url, 2).await.unwrap();
    let a = bootstrap("notify_a");
    let b = bootstrap("notify_b");
    store.bootstrap_operator(&a).await.unwrap();
    store.bootstrap_operator(&b).await.unwrap();
    let new = |org: &str, recipient: &str, key: &str, at: i64| NewNotification {
        id: format!("ntf_{}", uuid::Uuid::new_v4().simple()),
        org_id: org.into(),
        recipient_user_id: recipient.into(),
        workspace_id: Some(a.workspace_id.clone()),
        kind: NotificationKind::IssueAssigned,
        subject: NotificationSubject {
            entity: "issue".into(),
            id: "iss_1".into(),
        },
        actor_user_id: Some(a.user_id.clone()),
        dedupe_key: key.into(),
        created_at: at,
    };

    let (first, created) = store
        .record(new(&a.org_id, &a.user_id, "k1", 1))
        .await
        .unwrap();
    assert!(created);
    let (second, _) = store
        .record(new(&a.org_id, &a.user_id, "k2", 2))
        .await
        .unwrap();
    let (other, _) = store
        .record(new(&a.org_id, &b.user_id, "k1", 3))
        .await
        .unwrap();
    assert_eq!((first.seq, second.seq, other.seq), (1, 2, 1));
    let (replayed, created) = store
        .record(new(&a.org_id, &a.user_id, "k1", 4))
        .await
        .unwrap();
    assert!(!created);
    assert_eq!(replayed.id, first.id);

    // Concurrent writers for one recipient still get distinct, gapless seqs.
    let writes = (0..8).map(|i| {
        let store = &store;
        let input = new(&a.org_id, &a.user_id, &format!("burst{i}"), 5);
        async move { store.record(input).await.unwrap().0.seq }
    });
    let mut seqs = futures_util::future::join_all(writes).await;
    seqs.sort_unstable();
    assert_eq!(seqs, (3..=10).collect::<Vec<_>>());

    let listed = store.list(&a.org_id, &a.user_id, 1, 100).await.unwrap();
    assert_eq!(listed.first().map(|row| row.seq), Some(2));
    assert_eq!(listed.len(), 9);
    // Another tenant's scope sees none of it.
    assert!(store
        .list(&b.org_id, &a.user_id, 0, 100)
        .await
        .unwrap()
        .is_empty());

    // Marking is per recipient and idempotent; reads page by (read_at, seq).
    let marked = store
        .mark_read(
            &a.org_id,
            &b.user_id,
            &ReadSelector::Ids(vec![first.id.clone()]),
            50,
        )
        .await
        .unwrap();
    assert_eq!(marked, 0, "someone else's id marks nothing");
    let marked = store
        .mark_read(&a.org_id, &a.user_id, &ReadSelector::UpToSeq(3), 50)
        .await
        .unwrap();
    assert_eq!(marked, 3);
    let reads = store
        .list_reads(&a.org_id, &a.user_id, ReadCursor::default(), 2)
        .await
        .unwrap();
    assert_eq!(reads.iter().map(|r| r.seq).collect::<Vec<_>>(), vec![1, 2]);
    let rest = store
        .list_reads(&a.org_id, &a.user_id, ReadCursor { at: 50, seq: 2 }, 10)
        .await
        .unwrap();
    assert_eq!(rest.iter().map(|r| r.seq).collect::<Vec<_>>(), vec![3]);

    // A write past the read retention prunes this recipient's old read rows
    // and leaves their unread ones and everyone else's alone.
    store
        .record(new(&a.org_id, &a.user_id, "late", READ_RETENTION_MS + 10))
        .await
        .unwrap();
    let remaining = store.list(&a.org_id, &a.user_id, 0, 100).await.unwrap();
    assert!(remaining.iter().all(|row| row.seq > 3));
    assert_eq!(store.latest_seq(&a.org_id, &a.user_id).await.unwrap(), 11);
    assert_eq!(
        store
            .list(&a.org_id, &b.user_id, 0, 100)
            .await
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL instance"]
async fn a_targeted_invite_is_accepted_by_its_target_alone_in_postgres() {
    use cognia_collab_server::chat::{SessionRole, SessionStatus};
    use cognia_collab_server::chat_store::{ChatStore, NewChatSessionInvite, NewSharedSession};
    use cognia_collab_server::store::StoreError;

    let database = TestDatabase::create().await;
    let store = PgStore::connect_admin(&database.url, 2).await.unwrap();
    let scope = bootstrap("invite_owner");
    store.bootstrap_operator(&scope).await.unwrap();
    let mut people = Vec::new();
    for suffix in ["invite_target", "invite_other"] {
        let mut person = bootstrap(suffix);
        person.org_id = scope.org_id.clone();
        person.logto_organization_id = scope.logto_organization_id.clone();
        person.workspace_id = scope.workspace_id.clone();
        store.bootstrap_operator(&person).await.unwrap();
        people.push(person.user_id);
    }
    let (target, other) = (&people[0], &people[1]);
    let session_id = format!("session_{}", uuid::Uuid::new_v4().simple());
    store
        .create_session(NewSharedSession {
            id: session_id.clone(),
            org_id: scope.org_id.clone(),
            workspace_id: scope.workspace_id.clone(),
            title: "Invites".into(),
            status: SessionStatus::Active,
            created_by_user_id: scope.user_id.clone(),
            now: 1,
            operation_id: session_id.clone(),
        })
        .await
        .unwrap();
    let invite =
        |id: &str, token_hash: &str, target_user_id: Option<String>| NewChatSessionInvite {
            id: id.into(),
            org_id: scope.org_id.clone(),
            workspace_id: scope.workspace_id.clone(),
            session_id: session_id.clone(),
            token_hash: token_hash.into(),
            // `chat_invite_target`: an invite that names nobody is a guest invite.
            guest: target_user_id.is_none(),
            target_user_id,
            role: SessionRole::Member,
            approver: false,
            created_by_user_id: scope.user_id.clone(),
            expires_at: 1_000,
            now: 2,
        };
    store
        .create_invite(invite("inv_named", "hash_named", Some(target.clone())))
        .await
        .unwrap();
    store
        .create_invite(invite("inv_open", "hash_open", None))
        .await
        .unwrap();

    let unavailable =
        |result: Result<_, StoreError>| matches!(result, Err(StoreError::InvitationUnavailable));
    // Someone else cannot use a named invite's id, and nobody can use the id
    // of an invite that names no one: that one needs its token.
    assert!(unavailable(
        store
            .accept_targeted_invite(&scope.org_id, "inv_named", other, 3)
            .await
    ));
    assert!(unavailable(
        store
            .accept_targeted_invite(&scope.org_id, "inv_open", other, 3)
            .await
    ));
    let (accepted, membership) = store
        .accept_targeted_invite(&scope.org_id, "inv_named", target, 3)
        .await
        .unwrap();
    assert_eq!(accepted.status, "accepted");
    assert_eq!(membership.user_id, *target);
    assert!(unavailable(
        store
            .accept_targeted_invite(&scope.org_id, "inv_named", target, 4)
            .await
    ));
    // The token path still works on the same refactored statement.
    let (by_token, _) = store
        .accept_invite(&scope.org_id, "hash_open", other, 4)
        .await
        .unwrap();
    assert_eq!(by_token.id, "inv_open");
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

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL instance with role creation privileges"]
async fn device_person_resolution_preserves_rls_exact_links_and_host_org_scope() {
    use axum::{
        body::{to_bytes, Body},
        http::{Request, StatusCode},
    };
    use cognia_collab_server::{router, AppState};
    use cognia_tenant_auth::{grant::GrantSigner, oidc::TestAuthenticator};
    use sha2::Digest;
    use std::sync::Arc;
    use tower::ServiceExt;

    let database = TestDatabase::create().await;
    let admin = PgStore::connect_admin(&database.url, 2).await.unwrap();
    let owner = bootstrap("device_person_a");
    let mut other = bootstrap("device_person_b");
    other.user_id = owner.user_id.clone();
    admin.bootstrap_operator(&owner).await.unwrap();
    admin.bootstrap_operator(&other).await.unwrap();
    let role = format!("identity_app_{}", uuid::Uuid::new_v4().simple());
    let app_url = format!(
        "{}&user={role}&password=identity-test-password",
        database.url
    );
    let store = PgStore::connect_with_options(
        &app_url,
        2,
        PgConnectOptions {
            migration_database_url: Some(&database.url),
            app_db_role: Some(&role),
            app_db_password: Some("identity-test-password"),
            ..PgConnectOptions::default()
        },
    )
    .await
    .unwrap();
    let hash = hex::encode(sha2::Sha256::digest(b"host-identity-test"));
    let mut state = AppState::new(
        Arc::new(store),
        GrantSigner::new(&[9; 32]).unwrap(),
        Arc::new(TestAuthenticator),
    );
    assert!(!state.account_control.enabled);
    state.internal_service_credential_sha256 = Some(hash.clone());
    state.internal_service_credential_scopes = Some(std::collections::HashMap::from([(
        hash,
        vec![owner.org_id.clone()],
    )]));
    let app = router(state);
    for (organization, subject, credential, expected, code) in [
        (
            &owner.logto_organization_id,
            &owner.identity_subject,
            "host-identity-test",
            StatusCode::OK,
            None,
        ),
        (
            &other.logto_organization_id,
            &owner.identity_subject,
            "host-identity-test",
            StatusCode::FORBIDDEN,
            Some("oidc_identity_unlinked"),
        ),
        (
            &other.logto_organization_id,
            &other.identity_subject,
            "host-identity-test",
            StatusCode::FORBIDDEN,
            Some("host_service_credential_scope"),
        ),
        (
            &owner.logto_organization_id,
            &owner.identity_subject,
            "wrong-host",
            StatusCode::UNAUTHORIZED,
            Some("host_service_credential_invalid"),
        ),
    ] {
        let token = format!("{organization}:collab:read@{subject}");
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/internal/v1/device-person")
                    .header("authorization", format!("Bearer {credential}"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({"accessToken":token}).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let body: serde_json::Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 8192).await.unwrap()).unwrap();
        assert_eq!(status, expected, "{body}");
        if let Some(code) = code {
            assert_eq!(body["code"], code);
        } else {
            assert_eq!(body["userId"], owner.user_id);
            assert_eq!(body["orgId"], owner.org_id);
            assert!(body.get("grant").is_none());
        }
    }
    drop((app, admin));
    database.cleanup_with_role(Some(&role)).await;
}

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL instance"]
async fn session_files_flow_through_postgres_under_rls() {
    use cognia_collab_server::chat::{SessionRole, SessionStatus};
    use cognia_collab_server::chat_store::{ChatStore, NewSharedSession};
    use cognia_collab_server::session_files::{
        FileGrant, FileHost, FileOp, FileRequest, GrantPath, RequestOutcome, RequestStatus,
        ResultObject, SessionFileStore, UploadSpec, REQUEST_WAIT_MS, RESULT_TTL_MS,
    };

    let database = TestDatabase::create().await;
    let store = PgStore::connect_admin(&database.url, 4).await.unwrap();
    let scope = bootstrap("files_owner");
    store.bootstrap_operator(&scope).await.unwrap();
    let mut member = bootstrap("files_member");
    member.org_id = scope.org_id.clone();
    member.logto_organization_id = scope.logto_organization_id.clone();
    member.workspace_id = scope.workspace_id.clone();
    store.bootstrap_operator(&member).await.unwrap();
    let other = bootstrap("files_other_org");
    store.bootstrap_operator(&other).await.unwrap();
    let session_id = format!("session_{}", uuid::Uuid::new_v4());
    store
        .create_session(NewSharedSession {
            id: session_id.clone(),
            org_id: scope.org_id.clone(),
            workspace_id: scope.workspace_id.clone(),
            title: "Files".into(),
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
            &member.user_id,
            SessionRole::Member,
            false,
            false,
            &scope.user_id,
            2,
        )
        .await
        .unwrap();

    let host = store
        .put_host(FileHost {
            org_id: scope.org_id.clone(),
            workspace_id: scope.workspace_id.clone(),
            session_id: session_id.clone(),
            registered_by: scope.user_id.clone(),
            host_token_hash: "a".repeat(64),
            host_label: "Mac".into(),
            registered_at: 10,
            last_seen_at: None,
        })
        .await
        .unwrap();
    assert_eq!(host.last_seen_at, None);
    store.touch_host(&scope.org_id, &session_id, 11).await.unwrap();
    assert_eq!(
        store.host(&scope.org_id, &session_id).await.unwrap().unwrap().last_seen_at,
        Some(11)
    );
    // Another tenant sees nothing.
    assert!(store.host(&other.org_id, &session_id).await.unwrap().is_none());

    let grant = store
        .put_grant(FileGrant {
            id: "fg_pg".into(),
            org_id: scope.org_id.clone(),
            workspace_id: scope.workspace_id.clone(),
            session_id: session_id.clone(),
            label: Some("Design".into()),
            user_ids: Some(vec![member.user_id.clone()]),
            min_role: SessionRole::Viewer,
            permissions: vec!["read".into(), "download".into()],
            paths: vec![GrantPath { path: "/workspace/src".into(), is_dir: true }],
            status: "active".into(),
            expires_at: 1_000_000,
            revoked_at: None,
            policy_revision: 0,
            created_by: scope.user_id.clone(),
            created_at: 12,
            updated_at: 12,
        })
        .await
        .unwrap();
    assert_eq!(grant.user_ids.as_deref(), Some(&[member.user_id.clone()][..]));
    assert_eq!(store.grants(&scope.org_id, &session_id).await.unwrap().len(), 1);

    // A grant id is the host's choice and unique within its org only: another
    // org holding the same id neither collides nor sees this one.
    let other_session = format!("session_{}", uuid::Uuid::new_v4());
    store
        .create_session(NewSharedSession {
            id: other_session.clone(),
            org_id: other.org_id.clone(),
            workspace_id: other.workspace_id.clone(),
            title: "Elsewhere".into(),
            status: SessionStatus::Active,
            created_by_user_id: other.user_id.clone(),
            now: 1,
            operation_id: other_session.clone(),
        })
        .await
        .unwrap();
    let elsewhere = store
        .put_grant(FileGrant {
            id: "fg_pg".into(),
            org_id: other.org_id.clone(),
            workspace_id: other.workspace_id.clone(),
            session_id: other_session.clone(),
            label: None,
            user_ids: None,
            min_role: SessionRole::Viewer,
            permissions: vec!["read".into()],
            paths: vec![GrantPath { path: "/workspace".into(), is_dir: true }],
            status: "active".into(),
            expires_at: 1_000_000,
            revoked_at: None,
            policy_revision: 0,
            created_by: other.user_id.clone(),
            created_at: 13,
            updated_at: 13,
        })
        .await
        .unwrap();
    assert_eq!(elsewhere.org_id, other.org_id);
    let ours = store.grant(&scope.org_id, &session_id, "fg_pg").await.unwrap().unwrap();
    assert_eq!(ours.label.as_deref(), Some("Design"), "untouched by the other org's grant");

    let request = |id: &str, op: FileOp, upload: Option<UploadSpec>| FileRequest {
        id: id.into(),
        org_id: scope.org_id.clone(),
        workspace_id: scope.workspace_id.clone(),
        session_id: session_id.clone(),
        grant_id: "fg_pg".into(),
        requester_user_id: member.user_id.clone(),
        requester_role: SessionRole::Member,
        op,
        path: "/workspace/src/a.ts".into(),
        dest_path: None,
        status: if upload.is_some() { RequestStatus::AwaitingUpload } else { RequestStatus::Pending },
        upload,
        result: None,
        result_object: None,
        error: None,
        created_at: 20,
        claimed_at: None,
        completed_at: None,
        expires_at: 20 + REQUEST_WAIT_MS,
    };
    store.create_request(request("frq_read", FileOp::Read, None)).await.unwrap();
    store
        .create_request(request(
            "frq_write",
            FileOp::Write,
            Some(UploadSpec { byte_length: 2, sha256: "b".repeat(64), object_key: "obj/upload".into() }),
        ))
        .await
        .unwrap();
    assert_eq!(store.open_requests(&scope.org_id, &session_id, 21).await.unwrap().len(), 2);

    // Two claims never take the same request.
    // A host token that is not the registered one claims nothing.
    let stranger = "b".repeat(64);
    assert!(store.claim_next(&scope.org_id, &session_id, &stranger, 30).await.unwrap().is_none());
    let token_hash = "a".repeat(64);
    let (a, b) = tokio::join!(
        store.claim_next(&scope.org_id, &session_id, &token_hash, 30),
        store.claim_next(&scope.org_id, &session_id, &token_hash, 30)
    );
    let claimed: Vec<_> = [a.unwrap(), b.unwrap()].into_iter().flatten().collect();
    assert_eq!(claimed.len(), 1, "the write still waits for its bytes");
    assert_eq!(claimed[0].id, "frq_read");
    assert_eq!(claimed[0].status, RequestStatus::Claimed);

    let done = store
        .complete_request(
            &scope.org_id,
            &session_id,
            "frq_read",
            RequestOutcome::Done {
                result: None,
                object: Some(ResultObject {
                    object_key: "obj/result".into(),
                    byte_length: 5,
                    media_type: "text/plain".into(),
                }),
            },
            40,
        )
        .await
        .unwrap();
    assert_eq!(done.status, RequestStatus::Done);
    assert_eq!(done.expires_at, 40 + RESULT_TTL_MS);
    // A second answer conflicts.
    assert!(store
        .complete_request(
            &scope.org_id,
            &session_id,
            "frq_read",
            RequestOutcome::Failed { error: "again".into() },
            41,
        )
        .await
        .is_err());

    let uploaded = store
        .mark_uploaded(&scope.org_id, &session_id, "frq_write", 50)
        .await
        .unwrap();
    assert_eq!(uploaded.status, RequestStatus::Pending);
    let mut keys = store.session_object_keys(&scope.org_id, &session_id).await.unwrap();
    keys.sort();
    assert_eq!(keys, vec!["obj/result".to_string(), "obj/upload".to_string()]);

    // Past every deadline, the reaper hands back both keys once.
    let mut reaped = store
        .reap_requests(&scope.org_id, &session_id, 40 + RESULT_TTL_MS + REQUEST_WAIT_MS)
        .await
        .unwrap();
    reaped.sort();
    assert_eq!(reaped, keys);
    assert!(store
        .reap_requests(&scope.org_id, &session_id, 40 + RESULT_TTL_MS + REQUEST_WAIT_MS)
        .await
        .unwrap()
        .is_empty());
    let write = store.request(&scope.org_id, &session_id, "frq_write").await.unwrap().unwrap();
    assert_eq!(write.status, RequestStatus::Expired);

    // Removing the host revokes its grants.
    store.delete_host(&scope.org_id, &session_id, 99).await.unwrap();
    assert!(store.host(&scope.org_id, &session_id).await.unwrap().is_none());
    let revoked = store.grant(&scope.org_id, &session_id, "fg_pg").await.unwrap().unwrap();
    assert_eq!(revoked.status, "revoked");
    assert_eq!(revoked.revoked_at, Some(99));
    assert!(!store.revoke_grant(&scope.org_id, &session_id, "fg_pg", 100).await.unwrap());

    drop(store);
    database.cleanup().await;
}

// P0a standing fences: the same isolated-database lifecycle as the queue and
// invitation scenarios above. Store operations use the migration/admin role;
// a separate non-BYPASSRLS connection checks the persisted result under RLS.
fn standing_context(actor: &str) -> cognia_collab_server::store::AuthorizationContext {
    cognia_collab_server::store::AuthorizationContext {
        actor_user_id: actor.into(), reason: "standing integration".into(), request_id: "standing-request".into(),
        grant_id: None, source: serde_json::json!({}), now: 10,
    }
}

async fn standing_fixture() -> (TestDatabase, PgStore, OperatorBootstrap, OperatorBootstrap, OperatorBootstrap) {
    use cognia_collab_server::{chat::{SessionRole, SessionStatus}, chat_store::{ChatStore, NewSharedSession}, Store};
    use cognia_tenant_auth::{OrgRole, WorkspaceRole};
    let database = TestDatabase::create().await;
    let store = PgStore::connect_admin(&database.url, 4).await.unwrap();
    let owner = bootstrap("standing_owner");
    store.bootstrap_operator(&owner).await.unwrap();
    let mut member = bootstrap("standing_member");
    let mut guest = bootstrap("standing_guest");
    for participant in [&mut member, &mut guest] {
        participant.org_id = owner.org_id.clone();
        participant.logto_organization_id = owner.logto_organization_id.clone();
        participant.workspace_id = owner.workspace_id.clone();
        store.bootstrap_operator(participant).await.unwrap();
        store.set_org_member(&owner.org_id, &participant.user_id, OrgRole::Member, standing_context(&owner.user_id)).await.unwrap();
        store.set_workspace_member(&owner.org_id, &owner.workspace_id, &participant.user_id, WorkspaceRole::Maintainer, standing_context(&owner.user_id)).await.unwrap();
    }
    store.create_session(NewSharedSession {
        id: "standing_session".into(), org_id: owner.org_id.clone(), workspace_id: owner.workspace_id.clone(), title: "Standing".into(),
        status: SessionStatus::Active, created_by_user_id: owner.user_id.clone(), now: 1, operation_id: "standing-create".into(),
    }).await.unwrap();
    store.put_member(&owner.org_id, "standing_session", &owner.workspace_id, &member.user_id, SessionRole::Maintainer, true, false, &owner.user_id, 2).await.unwrap();
    store.put_member(&owner.org_id, "standing_session", &owner.workspace_id, &guest.user_id, SessionRole::Member, false, true, &owner.user_id, 2).await.unwrap();
    (database, store, owner, member, guest)
}

fn standing_lease(scope: &OperatorBootstrap, user_id: &str) -> cognia_collab_server::chat_store::NewChatRunLease {
    cognia_collab_server::chat_store::NewChatRunLease {
        id: "standing_lease".into(), org_id: scope.org_id.clone(), workspace_id: scope.workspace_id.clone(), session_id: "standing_session".into(),
        run_id: "standing_run".into(), holder_user_id: user_id.into(), holder_device_id: "device".into(), token_hash: "standing-token".into(),
        token_expires_at: 100, heartbeat_expires_at: 100, now: 3, operation_id: "standing-lease-op".into(),
    }
}

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL instance and COLLAB_RLS_ADMIN_DATABASE_URL / COLLAB_RLS_APP_DATABASE_URL"]
async fn losing_a_workspace_seat_keeps_an_org_admins_session_standing_in_postgres() {
    use cognia_collab_server::{chat::SessionRole, chat_store::ChatStore, Store};
    use cognia_tenant_auth::OrgRole;
    let (_database, store, owner, member, _guest) = standing_fixture().await;
    let org = &owner.org_id;
    store.set_org_member(org, &member.user_id, OrgRole::Admin, standing_context(&owner.user_id)).await.unwrap();
    let revision = store.admin_session(org, "standing_session").await.unwrap().policy_revision;
    let affected = store.remove_workspace_member(org, &owner.workspace_id, &member.user_id, standing_context(&owner.user_id)).await.unwrap();
    assert!(affected.is_empty(), "an org admin still traverses the workspace");
    assert_eq!(store.admin_session(org, "standing_session").await.unwrap().policy_revision, revision);
    let effective = store.effective_member(org, "standing_session", &member.user_id).await.unwrap().unwrap();
    assert_eq!(effective.role, SessionRole::Maintainer);
    assert!(effective.approver);
}

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL instance and COLLAB_RLS_ADMIN_DATABASE_URL / COLLAB_RLS_APP_DATABASE_URL"]
async fn standing_removal_revokes_work_invites_and_membership_but_preserves_session_guests() {
    use cognia_collab_server::{chat_store::{ChatStore, NewChatRunQueueItem, NewChatSessionInvite}, Store};
    for offboard in [true, false] {
        let (database, store, owner, member, guest) = standing_fixture().await;
        let org = &owner.org_id;
        store.enqueue_run_input(NewChatRunQueueItem {
            id: "standing_queue".into(), org_id: org.clone(), workspace_id: owner.workspace_id.clone(), session_id: "standing_session".into(),
            requested_by_user_id: member.user_id.clone(), payload: serde_json::json!({"parts":[]}), now: 3, operation_id: "standing-queue-op".into(),
        }).await.unwrap();
        store.acquire_run_lease(standing_lease(&owner, &member.user_id)).await.unwrap();
        store.create_invite(NewChatSessionInvite {
            id: "standing_invite".into(), org_id: org.clone(), workspace_id: owner.workspace_id.clone(), session_id: "standing_session".into(),
            token_hash: "standing-invite-token".into(), target_user_id: None, role: cognia_collab_server::chat::SessionRole::Member,
            approver: false, guest: true, created_by_user_id: member.user_id.clone(), expires_at: 100, now: 3,
        }).await.unwrap();
        let revision = store.admin_session(org, "standing_session").await.unwrap().policy_revision;
        let affected = if offboard {
            store.offboard_org_member(org, &member.user_id, standing_context(&owner.user_id)).await.unwrap()
        } else {
            store.remove_workspace_member(org, &owner.workspace_id, &member.user_id, standing_context(&owner.user_id)).await.unwrap()
        };
        assert_eq!(affected, ["standing_session"]);
        assert_eq!(store.admin_session(org, "standing_session").await.unwrap().policy_revision, revision + 1);
        assert!(store.visible_session(org, "standing_session", &member.user_id).await.unwrap().is_none());
        assert!(store.list_sessions(org, &member.user_id, None).await.unwrap().is_empty());
        assert!(store.claim_run_queue(standing_lease(&owner, &member.user_id), "standing_queue", false).await.is_err());
        assert!(store.validate_run_token(org, "standing_session", "standing_run", "standing-token", 10).await.is_err());
        assert!(store.active_run_lease(org, "standing_session", 10).await.unwrap().is_none());
        assert!(store.list_run_queue(org, "standing_session").await.unwrap().is_empty());
        assert_eq!(store.list_invites(org, "standing_session", 10).await.unwrap()[0].status, "revoked");
        assert!(matches!(store.accept_invite(org, "standing-invite-token", &guest.user_id, 10).await, Err(cognia_collab_server::store::StoreError::InvitationUnavailable)));
        store.remove_workspace_member(org, &owner.workspace_id, &guest.user_id, standing_context(&owner.user_id)).await.unwrap();
        store.offboard_org_member(org, &guest.user_id, standing_context(&owner.user_id)).await.unwrap();
        assert!(store.visible_session(org, "standing_session", &guest.user_id).await.unwrap().is_none());
        let external = bootstrap("external_session_guest");
        store.bootstrap_operator(&external).await.unwrap();
        store.put_member(org, "standing_session", &owner.workspace_id, &external.user_id, cognia_collab_server::chat::SessionRole::Member, false, true, &owner.user_id, 10).await.unwrap();
        assert!(matches!(store.offboard_org_member(org, &external.user_id, standing_context(&owner.user_id)).await, Err(cognia_collab_server::store::StoreError::NotFound)));
        assert!(store.visible_session(org, "standing_session", &external.user_id).await.unwrap().is_some());
        assert!(matches!(store.offboard_org_member(org, &owner.user_id, standing_context(&owner.user_id)).await, Err(cognia_collab_server::store::StoreError::LastOwner)));

        let (admin, connection) = tokio_postgres::connect(&database.url, NoTls).await.unwrap();
        let admin_task = tokio::spawn(async move { connection.await.unwrap() });
        assert_eq!(admin.query_one("SELECT status FROM chat_run_leases WHERE id='standing_lease'", &[]).await.unwrap().get::<_, String>(0), "failed");
        assert_eq!(admin.query_one("SELECT status FROM chat_run_queue WHERE id='standing_queue'", &[]).await.unwrap().get::<_, String>(0), "cancelled");
        let app_url = TestDatabase::url_for(&std::env::var("COLLAB_RLS_APP_DATABASE_URL").unwrap(), &database.name);
        drop(PgStore::connect_with_options(&app_url, 2, PgConnectOptions {
            migration_database_url: Some(&database.url),
            ..PgConnectOptions::default()
        }).await.unwrap());
        let (mut app, connection) = tokio_postgres::connect(&app_url, NoTls).await.unwrap();
        let app_task = tokio::spawn(async move { connection.await.unwrap() });
        let role = app.query_one("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user", &[]).await.unwrap();
        assert!(!role.get::<_, bool>(0) && !role.get::<_, bool>(1));
        let tx = app.transaction().await.unwrap();
        tx.execute("SELECT set_config('app.tenant_id',$1,true)", &[org]).await.unwrap();
        assert_eq!(tx.query_one("SELECT count(*) FROM chat_session_memberships WHERE session_id='standing_session' AND user_id=$1", &[&member.user_id]).await.unwrap().get::<_, i64>(0), 0);
        assert_eq!(tx.query_one("SELECT count(*) FROM chat_session_memberships WHERE session_id='standing_session' AND user_id=$1 AND guest", &[&guest.user_id]).await.unwrap().get::<_, i64>(0), 0);
        tx.commit().await.unwrap();
        drop((app, admin, store));
        app_task.await.unwrap();
        admin_task.await.unwrap();
        database.cleanup().await;
    }
}

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL instance"]
async fn standing_demotion_clamps_roles_approver_and_invalidates_a_lease_in_postgres() {
    use cognia_collab_server::{chat::SessionRole, chat_store::ChatStore, Store};
    use cognia_tenant_auth::WorkspaceRole;
    let (database, store, owner, member, guest) = standing_fixture().await;
    let org = &owner.org_id;
    store.acquire_run_lease(standing_lease(&owner, &member.user_id)).await.unwrap();
    let before = store.admin_session(org, "standing_session").await.unwrap().policy_revision;
    for (workspace_role, session_role) in [(WorkspaceRole::Member, SessionRole::Maintainer), (WorkspaceRole::Viewer, SessionRole::Viewer)] {
        let affected = store.set_workspace_member(org, &owner.workspace_id, &member.user_id, workspace_role, standing_context(&owner.user_id)).await.unwrap();
        if workspace_role == WorkspaceRole::Member { assert!(affected.is_empty()); } else { assert_eq!(affected, ["standing_session"]); }
        let effective = store.effective_member(org, "standing_session", &member.user_id).await.unwrap().unwrap();
        assert_eq!(effective.role, session_role);
        assert_eq!(effective.approver, session_role != SessionRole::Viewer);
        assert!(store.visible_session(org, "standing_session", &guest.user_id).await.unwrap().is_some());
    }
    assert_eq!(store.admin_session(org, "standing_session").await.unwrap().policy_revision, before + 1);
    assert!(store.heartbeat_run_lease(org, "standing_session", "standing_lease", &member.user_id, "device", "standing-token", 90, 10).await.is_err());
    assert!(store.release_run_lease(org, "standing_session", "standing_lease", &member.user_id, "device", "standing-token", 10, "completed").await.is_err());
    assert!(store.active_run_lease(org, "standing_session", 10).await.unwrap().is_none());
    drop(store);
    database.cleanup().await;
}

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL instance"]
async fn legacy_standing_is_fenced_and_repaired_in_bounded_postgres_batches() {
    use cognia_collab_server::{chat::SessionRole, chat_store::{ChatStore, NewChatApprovalRequest, NewChatSessionInvite}, standing_audit::audit_standing};
    let (database, store, owner, member, _) = standing_fixture().await;
    let org = &owner.org_id;
    store.acquire_run_lease(standing_lease(&owner, &member.user_id)).await.unwrap();
    let approval = store.create_approval(NewChatApprovalRequest {
        id: "standing_approval".into(), org_id: org.clone(), workspace_id: owner.workspace_id.clone(), session_id: "standing_session".into(),
        run_id: "standing_run".into(), action: "delete".into(), risk: "high".into(), requested_by_user_id: member.user_id.clone(),
        expires_at: 90, now: 4, operation_id: "standing-approval-op".into(),
    }).await.unwrap();
    store.create_invite(NewChatSessionInvite {
        id: "legacy_invite".into(), org_id: org.clone(), workspace_id: owner.workspace_id.clone(), session_id: "standing_session".into(),
        token_hash: "legacy-invite-token".into(), target_user_id: None, role: SessionRole::Member, approver: false, guest: true,
        created_by_user_id: member.user_id.clone(), expires_at: 100, now: 4,
    }).await.unwrap();
    let (admin, connection) = tokio_postgres::connect(&database.url, NoTls).await.unwrap();
    let admin_task = tokio::spawn(async move { connection.await.unwrap() });
    // A legacy role above its ceiling is capped before the audit writes.
    admin.execute("UPDATE workspace_memberships SET role='viewer' WHERE org_id=$1 AND workspace_id=$2 AND user_id=$3", &[org,&owner.workspace_id,&member.user_id]).await.unwrap();
    let effective = store.effective_member(org, "standing_session", &member.user_id).await.unwrap().unwrap();
    assert_eq!(effective.role, SessionRole::Viewer);
    assert!(!effective.approver);
    assert!(store.resolve_approval(org, "standing_session", "standing_approval", &member.user_id, "approved", approval.revision, 5).await.is_err());
    assert!(matches!(store.accept_invite(org, "legacy-invite-token", &owner.user_id, 5).await, Err(cognia_collab_server::store::StoreError::InvitationUnavailable)));
    assert_eq!(audit_standing(&store, false, 1, 5).await.unwrap().exceeds_ceiling, 1);
    assert_eq!(audit_standing(&store, true, 1, 5).await.unwrap().applied, 1);
    assert!(store.active_run_lease(org, "standing_session", 5).await.unwrap().is_none());
    // A legacy offboard left the capped session row behind.
    admin.execute("DELETE FROM workspace_memberships WHERE org_id=$1 AND user_id=$2", &[org,&member.user_id]).await.unwrap();
    admin.execute("DELETE FROM org_memberships WHERE org_id=$1 AND user_id=$2", &[org,&member.user_id]).await.unwrap();
    assert!(store.visible_session(org, "standing_session", &member.user_id).await.unwrap().is_none());
    assert!(store.list_sessions(org, &member.user_id, None).await.unwrap().is_empty());
    assert!(!store.list_members(org, "standing_session").await.unwrap().iter().any(|m| m.user_id == member.user_id));
    let dry = audit_standing(&store, false, 1, 6).await.unwrap();
    assert_eq!(dry.missing_standing, 1);
    assert_eq!(dry.issues[0].user_id, member.user_id);
    assert_eq!(audit_standing(&store, true, 1, 6).await.unwrap().applied, 1);
    assert!(audit_standing(&store, false, 1, 6).await.unwrap().issues.is_empty());
    drop((admin, store));
    admin_task.await.unwrap();
    database.cleanup().await;
}

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL instance"]
async fn legacy_demotion_fails_lease_on_heartbeat_or_completion_without_audit_cleanup() {
    use cognia_collab_server::chat_store::ChatStore;
    for heartbeat in [true, false] {
        let (database, store, owner, member, _) = standing_fixture().await;
        store.acquire_run_lease(standing_lease(&owner, &member.user_id)).await.unwrap();
        let (admin, connection) = tokio_postgres::connect(&database.url, NoTls).await.unwrap();
        let admin_task = tokio::spawn(async move { connection.await.unwrap() });
        admin.execute("UPDATE workspace_memberships SET role='viewer' WHERE org_id=$1 AND workspace_id=$2 AND user_id=$3", &[&owner.org_id,&owner.workspace_id,&member.user_id]).await.unwrap();
        let result = if heartbeat {
            store.heartbeat_run_lease(&owner.org_id, "standing_session", "standing_lease", &member.user_id, "device", "standing-token", 90, 10).await
        } else {
            store.release_run_lease(&owner.org_id, "standing_session", "standing_lease", &member.user_id, "device", "standing-token", 10, "completed").await
        };
        assert!(result.is_err());
        assert_eq!(admin.query_one("SELECT status FROM chat_run_leases WHERE id='standing_lease'", &[]).await.unwrap().get::<_, String>(0), "failed");
        drop((admin, store));
        admin_task.await.unwrap();
        database.cleanup().await;
    }
}

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL instance"]
async fn revoked_manager_cannot_mutate_members_or_create_invites_after_authorization_in_postgres() {
    use cognia_collab_server::{chat::{authorize_session_action, SessionAction, SessionRole}, chat_store::{ChatStore, NewChatSessionInvite}, store::StoreError, Store};
    let (database, store, owner, member, guest) = standing_fixture().await;
    let org = &owner.org_id;
    let actor = store.effective_member(org, "standing_session", &member.user_id).await.unwrap().unwrap();
    assert!(authorize_session_action(Some(&actor), SessionAction::ManageMembers, 1).allowed);
    store.offboard_org_member(org, &member.user_id, standing_context(&owner.user_id)).await.unwrap();
    assert!(matches!(store.put_member(org, "standing_session", &owner.workspace_id, &member.user_id, SessionRole::Member, false, true, &member.user_id, 11).await, Err(StoreError::Policy(reason)) if reason == "session member management revoked"));
    assert!(matches!(store.put_member(org, "standing_session", &owner.workspace_id, &guest.user_id, SessionRole::Viewer, false, true, &member.user_id, 11).await, Err(StoreError::Policy(reason)) if reason == "session member management revoked"));
    assert!(matches!(store.put_member(org, "standing_session", &owner.workspace_id, &owner.user_id, SessionRole::Owner, false, false, &member.user_id, 11).await, Err(StoreError::Policy(reason)) if reason == "session member management revoked"));
    assert!(matches!(store.remove_member(org, "standing_session", &guest.user_id, &member.user_id, 11).await, Err(StoreError::Policy(reason)) if reason == "session member management revoked"));
    assert!(matches!(store.create_invite(NewChatSessionInvite {
        id: "revoked-manager-invite".into(), org_id: org.clone(), workspace_id: owner.workspace_id.clone(), session_id: "standing_session".into(),
        token_hash: "revoked-manager-token".into(), target_user_id: None, role: SessionRole::Member, approver: false, guest: true,
        created_by_user_id: member.user_id.clone(), expires_at: 100, now: 11,
    }).await, Err(StoreError::Policy(reason)) if reason == "session member management revoked"));
    assert!(store.effective_member(org, "standing_session", &member.user_id).await.unwrap().is_none());
    assert_eq!(store.effective_member(org, "standing_session", &guest.user_id).await.unwrap().unwrap().role, SessionRole::Member);
    drop(store);
    database.cleanup().await;
}

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL instance"]
async fn actor_role_changes_protect_the_current_owner_inside_the_session_lock_in_postgres() {
    use cognia_collab_server::{chat::SessionRole, chat_store::ChatStore, store::StoreError};
    let (database, store, owner, member, _) = standing_fixture().await;
    let org = &owner.org_id;
    store.put_member(org, "standing_session", &owner.workspace_id, &member.user_id, SessionRole::Owner, true, false, &owner.user_id, 2).await.unwrap();
    assert_eq!(store.effective_member(org, "standing_session", &member.user_id).await.unwrap().unwrap().role, SessionRole::Owner);
    store.put_member(org, "standing_session", &owner.workspace_id, &member.user_id, SessionRole::Maintainer, true, false, &owner.user_id, 3).await.unwrap();
    assert!(matches!(store.put_member(org, "standing_session", &owner.workspace_id, &owner.user_id, SessionRole::Owner, false, false, &member.user_id, 4).await, Err(StoreError::Policy(_))));
    assert!(matches!(store.remove_member(org, "standing_session", &owner.user_id, &member.user_id, 4).await, Err(StoreError::Policy(_))));
    drop(store);
    database.cleanup().await;
}

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL instance"]
async fn writer_creator_keeps_ownership_but_another_manager_cannot_grant_it_in_postgres() {
    use cognia_collab_server::{chat::{SessionRole, SessionStatus}, chat_store::{ChatStore, NewSharedSession}, standing_audit::audit_standing, store::StoreError, Store};
    use cognia_tenant_auth::WorkspaceRole;
    let (database, store, owner, member, _) = standing_fixture().await;
    let org = &owner.org_id;
    assert!(store.set_workspace_member(org, &owner.workspace_id, &member.user_id, WorkspaceRole::Member, standing_context(&owner.user_id)).await.unwrap().is_empty());
    assert!(matches!(store.put_member(org, "standing_session", &owner.workspace_id, &member.user_id, SessionRole::Owner, true, false, &owner.user_id, 3).await, Err(StoreError::Policy(reason)) if reason == "session role exceeds grant ceiling"));
    store.create_session(NewSharedSession {
        id: "writer-created".into(), org_id: org.clone(), workspace_id: owner.workspace_id.clone(), title: "Writer import".into(),
        status: SessionStatus::Importing, created_by_user_id: member.user_id.clone(), now: 3, operation_id: "writer-created-op".into(),
    }).await.unwrap();
    assert_eq!(store.effective_member(org, "writer-created", &member.user_id).await.unwrap().unwrap().role, SessionRole::Owner);
    assert!(audit_standing(&store, false, 1, 4).await.unwrap().issues.is_empty());
    drop(store);
    database.cleanup().await;
}

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL instance"]
async fn offboarding_fences_incoming_invites_but_preserves_external_guests_and_new_tokens_in_postgres() {
    use cognia_collab_server::{chat::SessionRole, chat_store::{ChatStore, NewChatSessionInvite}, store::StoreError, Store};
    let (database, store, owner, member, _) = standing_fixture().await;
    let external = bootstrap("incoming_external");
    store.bootstrap_operator(&external).await.unwrap();
    let org = &owner.org_id;
    let invite = |id: &str, target: Option<&str>, now| NewChatSessionInvite {
        id: id.into(), org_id: org.clone(), workspace_id: owner.workspace_id.clone(), session_id: "standing_session".into(),
        token_hash: id.into(), target_user_id: target.map(str::to_owned), role: SessionRole::Member, approver: false, guest: true,
        created_by_user_id: owner.user_id.clone(), expires_at: 100, now,
    };
    for input in [invite("targeted", Some(&member.user_id), 3), invite("token", None, 3), invite("same-time", None, 10)] {
        store.create_invite(input).await.unwrap();
    }
    store.offboard_org_member(org, &member.user_id, standing_context(&owner.user_id)).await.unwrap();
    assert_eq!(store.list_invites(org, "standing_session", 11).await.unwrap().iter().find(|i| i.id == "targeted").unwrap().status, "revoked");
    assert!(matches!(store.accept_targeted_invite(org, "targeted", &member.user_id, 11).await, Err(StoreError::InvitationUnavailable)));
    for token in ["targeted", "token", "same-time"] {
        assert!(matches!(store.accept_invite(org, token, &member.user_id, 11).await, Err(StoreError::InvitationUnavailable)));
    }
    assert!(store.effective_member(org, "standing_session", &member.user_id).await.unwrap().is_none());
    assert!(store.accept_invite(org, "token", &external.user_id, 11).await.unwrap().1.guest);
    store.create_invite(invite("new-token", None, 11)).await.unwrap();
    assert!(store.accept_invite(org, "new-token", &member.user_id, 12).await.unwrap().1.guest);
    drop(store);
    database.cleanup().await;
}

async fn standing_file_host(store: &PgStore, scope: &OperatorBootstrap, registrant: &str) {
    use cognia_collab_server::{chat::SessionRole, session_files::{FileGrant, FileHost, GrantPath, SessionFileStore}};
    store.put_host(FileHost {
        org_id: scope.org_id.clone(), workspace_id: scope.workspace_id.clone(), session_id: "standing_session".into(),
        registered_by: registrant.into(), host_token_hash: "f".repeat(64), host_label: "Standing host".into(), registered_at: 3, last_seen_at: None,
    }).await.unwrap();
    store.put_grant(FileGrant {
        id: "standing_files".into(), org_id: scope.org_id.clone(), workspace_id: scope.workspace_id.clone(), session_id: "standing_session".into(),
        label: None, user_ids: None, min_role: SessionRole::Viewer, permissions: vec!["read".into(), "write".into()],
        paths: vec![GrantPath { path: "/workspace".into(), is_dir: true }], status: "active".into(), expires_at: 100_000,
        revoked_at: None, policy_revision: 1, created_by: registrant.into(), created_at: 3, updated_at: 3,
    }).await.unwrap();
}

fn standing_file_request(scope: &OperatorBootstrap, id: &str, requester: &str, op: cognia_collab_server::session_files::FileOp,
    status: cognia_collab_server::session_files::RequestStatus) -> cognia_collab_server::session_files::FileRequest {
    use cognia_collab_server::{chat::SessionRole, session_files::{FileRequest, REQUEST_WAIT_MS}};
    FileRequest {
        id: id.into(), org_id: scope.org_id.clone(), workspace_id: scope.workspace_id.clone(), session_id: "standing_session".into(),
        grant_id: "standing_files".into(), requester_user_id: requester.into(), requester_role: SessionRole::Maintainer,
        op, path: "/workspace/a.txt".into(), dest_path: None, upload: None, status, result: None, result_object: None, error: None,
        created_at: 4, claimed_at: None, completed_at: None, expires_at: 4 + REQUEST_WAIT_MS,
    }
}

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL instance"]
async fn requester_file_work_is_revoked_on_offboard_removal_and_demotion_in_postgres() {
    use cognia_collab_server::{chat::SessionRole, session_files::{FileOp, RequestStatus, SessionFileStore}, Store};
    use cognia_tenant_auth::WorkspaceRole;
    for change in ["offboard", "remove", "viewer"] {
        let (database, store, owner, member, guest) = standing_fixture().await;
        let org = &owner.org_id;
        standing_file_host(&store, &owner, &owner.user_id).await;
        for (id, op, status) in [("read", FileOp::Read, RequestStatus::Pending), ("write", FileOp::Write, RequestStatus::Pending),
            ("upload", FileOp::Write, RequestStatus::AwaitingUpload), ("claimed", FileOp::Write, RequestStatus::Claimed)] {
            store.create_request(standing_file_request(&owner, id, &member.user_id, op, status)).await.unwrap();
        }
        store.create_request(standing_file_request(&owner, "guest", &guest.user_id, FileOp::Read, RequestStatus::Pending)).await.unwrap();
        match change {
            "offboard" => { store.offboard_org_member(org, &member.user_id, standing_context(&owner.user_id)).await.unwrap(); }
            "remove" => { store.remove_workspace_member(org, &owner.workspace_id, &member.user_id, standing_context(&owner.user_id)).await.unwrap(); }
            _ => { store.set_workspace_member(org, &owner.workspace_id, &member.user_id, WorkspaceRole::Viewer, standing_context(&owner.user_id)).await.unwrap(); }
        }
        for id in ["read", "write", "upload"] {
            let request = store.request(org, "standing_session", id).await.unwrap().unwrap();
            if change == "viewer" && id == "read" { assert_eq!(request.status, RequestStatus::Pending); }
            else {
                assert_eq!(request.status, RequestStatus::Failed);
                assert_eq!(request.error.as_deref(), Some("revoked"));
            }
        }
        assert_eq!(store.request(org, "standing_session", "claimed").await.unwrap().unwrap().status, RequestStatus::Claimed);
        let guest_request = store.claim_next(org, "standing_session", &"f".repeat(64), 11).await.unwrap().unwrap();
        assert_eq!(guest_request.id, "guest", "other people's changes never revoke a Guest");
        if change == "viewer" {
            let read = store.claim_next(org, "standing_session", &"f".repeat(64), 11).await.unwrap().unwrap();
            assert_eq!(read.id, "read");
            assert_eq!(read.requester_role, SessionRole::Viewer);
        } else { assert!(store.claim_next(org, "standing_session", &"f".repeat(64), 11).await.unwrap().is_none()); }
        drop(store);
        database.cleanup().await;
    }
}

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL instance"]
async fn claim_rechecks_legacy_requesters_and_skips_revoked_file_work_in_postgres() {
    use cognia_collab_server::session_files::{FileOp, RequestStatus, SessionFileStore};
    let (database, store, owner, member, guest) = standing_fixture().await;
    let org = &owner.org_id;
    standing_file_host(&store, &owner, &owner.user_id).await;
    for (id, user, op) in [("a-read", &member.user_id, FileOp::Read), ("b-write", &member.user_id, FileOp::Write), ("c-guest", &guest.user_id, FileOp::Read)] {
        store.create_request(standing_file_request(&owner, id, user, op, RequestStatus::Pending)).await.unwrap();
    }
    let (admin, connection) = tokio_postgres::connect(&database.url, NoTls).await.unwrap();
    let admin_task = tokio::spawn(async move { connection.await.unwrap() });
    admin.execute("DELETE FROM workspace_memberships WHERE org_id=$1 AND user_id=$2", &[org, &member.user_id]).await.unwrap();
    assert_eq!(store.claim_next(org, "standing_session", &"f".repeat(64), 11).await.unwrap().unwrap().id, "c-guest");
    for id in ["a-read", "b-write"] {
        let request = store.request(org, "standing_session", id).await.unwrap().unwrap();
        assert_eq!(request.status, RequestStatus::Failed);
        assert_eq!(request.error.as_deref(), Some("revoked"));
    }
    drop((admin, store));
    admin_task.await.unwrap();
    database.cleanup().await;
}

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL instance"]
async fn cached_host_claims_are_fenced_and_unclaimed_work_fails_in_postgres() {
    use cognia_collab_server::session_files::{FileOp, RequestStatus, SessionFileStore};
    use cognia_collab_server::Store;
    use cognia_tenant_auth::WorkspaceRole;
    for change in ["offboard", "viewer", "legacy"] {
        let (database, store, owner, member, _) = standing_fixture().await;
        let org = &owner.org_id;
        standing_file_host(&store, &owner, &member.user_id).await;
        let cached_host = store.host(org, "standing_session").await.unwrap().unwrap();
        assert!(store.claim_next(org, "standing_session", &cached_host.host_token_hash, 5).await.unwrap().is_none());
        for (id, status) in [("pending", RequestStatus::Pending), ("upload", RequestStatus::AwaitingUpload), ("claimed", RequestStatus::Claimed)] {
            store.create_request(standing_file_request(&owner, id, &owner.user_id, FileOp::Read, status)).await.unwrap();
        }
        if change == "offboard" { store.offboard_org_member(org, &member.user_id, standing_context(&owner.user_id)).await.unwrap(); }
        else if change == "viewer" { store.set_workspace_member(org, &owner.workspace_id, &member.user_id, WorkspaceRole::Viewer, standing_context(&owner.user_id)).await.unwrap(); }
        else {
            let (admin, connection) = tokio_postgres::connect(&database.url, NoTls).await.unwrap();
            let task = tokio::spawn(async move { connection.await.unwrap() });
            admin.execute("DELETE FROM workspace_memberships WHERE org_id=$1 AND user_id=$2", &[org, &member.user_id]).await.unwrap();
            drop(admin);
            task.await.unwrap();
        }
        assert!(store.claim_next(org, "standing_session", &cached_host.host_token_hash, 11).await.unwrap().is_none());
        assert!(store.host(org, "standing_session").await.unwrap().is_none());
        assert_eq!(store.grant(org, "standing_session", "standing_files").await.unwrap().unwrap().status, "revoked");
        for id in ["pending", "upload"] {
            let request = store.request(org, "standing_session", id).await.unwrap().unwrap();
            assert_eq!(request.status, RequestStatus::Failed);
            assert_eq!(request.error.as_deref(), Some("revoked"));
        }
        assert_eq!(store.request(org, "standing_session", "claimed").await.unwrap().unwrap().status, RequestStatus::Claimed);
        // Equivalent to a long poll waking with work after offboarding committed.
        store.create_request(standing_file_request(&owner, "late", &owner.user_id, FileOp::Read, RequestStatus::Pending)).await.unwrap();
        assert!(store.claim_next(org, "standing_session", &cached_host.host_token_hash, 12).await.unwrap().is_none());
        drop(store);
        database.cleanup().await;
    }
}

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL instance"]
async fn invite_acceptance_waiting_behind_offboarding_cannot_recreate_a_guest_in_postgres() {
    use std::{sync::Arc, time::Duration};
    use cognia_collab_server::{chat::SessionRole, chat_store::{ChatStore, NewChatSessionInvite}, store::StoreError, Store};
    let (database, store, owner, member, _) = standing_fixture().await;
    let store = Arc::new(store);
    // No session row for this acceptor: session-only locking cannot serialize
    // an untargeted acceptance with offboarding's membership inventory.
    store.remove_member(&owner.org_id, "standing_session", &member.user_id, &owner.user_id, 3).await.unwrap();
    store.create_invite(NewChatSessionInvite {
        id: "racing-incoming".into(), org_id: owner.org_id.clone(), workspace_id: owner.workspace_id.clone(), session_id: "standing_session".into(),
        token_hash: "racing-incoming".into(), target_user_id: None, role: SessionRole::Member, approver: false, guest: true,
        created_by_user_id: owner.user_id.clone(), expires_at: 100, now: 4,
    }).await.unwrap();
    let (admin, connection) = tokio_postgres::connect(&database.url, NoTls).await.unwrap();
    let admin_task = tokio::spawn(async move { connection.await.unwrap() });
    admin.query_one("SELECT pg_advisory_lock_shared(hashtextextended('cognia.collab.invite-standing:' || $1::text, 0))", &[&owner.org_id]).await.unwrap();
    let offboard = {
        let store = store.clone();
        let org = owner.org_id.clone();
        let user = member.user_id.clone();
        let context = standing_context(&owner.user_id);
        tokio::spawn(async move { store.offboard_org_member(&org, &user, context).await })
    };
    let wait_for_blocked = |expected| {
        let admin = &admin;
        let name = &database.name;
        async move {
            tokio::time::timeout(Duration::from_secs(10), async {
                loop {
                    let waiting: i64 = admin.query_one("SELECT count(*) FROM pg_stat_activity WHERE application_name=$1 AND wait_event='advisory'", &[name]).await.unwrap().get(0);
                    if waiting == expected { break; }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            }).await.expect("operations must reach the standing barrier");
        }
    };
    wait_for_blocked(1).await;
    let accept = {
        let store = store.clone();
        let org = owner.org_id.clone();
        let user = member.user_id.clone();
        tokio::spawn(async move { store.accept_invite(&org, "racing-incoming", &user, 11).await })
    };
    wait_for_blocked(2).await;
    admin.query_one("SELECT pg_advisory_unlock_shared(hashtextextended('cognia.collab.invite-standing:' || $1::text, 0))", &[&owner.org_id]).await.unwrap();
    tokio::time::timeout(Duration::from_secs(10), offboard).await.unwrap().unwrap().unwrap();
    assert!(matches!(tokio::time::timeout(Duration::from_secs(10), accept).await.unwrap().unwrap(), Err(StoreError::InvitationUnavailable)));
    assert!(store.effective_member(&owner.org_id, "standing_session", &member.user_id).await.unwrap().is_none());
    drop((admin, store));
    admin_task.await.unwrap();
    database.cleanup().await;
}

fn rollout_policy() -> cognia_collab_server::rollout::FeaturePolicy {
    cognia_collab_server::rollout::validate_document(r#"{
        "feature_key":"shared-chat", "schema_version":1, "revision":0,
        "phase":"general", "kill":false, "allow_org_ids":[], "deny_org_ids":[],
        "deny_workspace_ids":[], "percentage_basis_points":0, "cohort_salt":"s1",
        "hash_version":1, "minimum_contract_version":1, "requires":[]
    }"#).unwrap()
}

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL instance with role creation privileges"]
async fn rollout_minimal_operator_cas_replay_and_atomic_audit() {
    use cognia_collab_server::{rollout::{FeatureKey, Phase}, store::StoreError};
    let database = TestDatabase::create().await;
    let missing = PgStore::connect_rollout(&database.url, 2).await.err().unwrap();
    assert!(missing.to_string().contains("run the server once to migrate"));
    let migrator = PgStore::connect_admin(&database.url, 2).await.unwrap();
    let (admin, connection) = tokio_postgres::connect(&database.url, NoTls).await.unwrap();
    let admin_task = tokio::spawn(async move { connection.await.unwrap() });
    let role = format!("rollout_{}", uuid::Uuid::new_v4().simple());
    admin.batch_execute(&format!(
        "CREATE ROLE {role} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD 'synthetic'; \
         GRANT USAGE ON SCHEMA public TO {role}; \
         GRANT SELECT, INSERT, UPDATE ON deployment_feature_policies TO {role}; \
         GRANT SELECT, INSERT ON deployment_feature_policy_audit TO {role};"
    )).await.unwrap();
    let url = format!("{}&user={role}&password=synthetic", database.url);
    assert!(PgStore::connect_operator(&url, 2).await.is_err());
    let store = PgStore::connect_rollout(&url, 2).await.unwrap();
    let principal = store.rollout_principal().await.unwrap();
    assert_eq!(principal, role);
    assert!(store.feature_policies().await.unwrap().is_empty());
    let p = rollout_policy();
    let first = store.apply_feature_policy(p.clone(), 0, "first", "launch", &principal).await.unwrap();
    assert_eq!(first.revision, 1);
    assert!(matches!(store.apply_feature_policy(p.clone(), 0, "stale", "launch", &principal).await, Err(StoreError::Conflict(_))));
    assert_eq!(store.apply_feature_policy(p.clone(), 0, "first", "launch", &principal).await.unwrap(), first);
    let mut next = p.clone();
    next.phase = Phase::Paused;
    assert!(matches!(store.apply_feature_policy(next.clone(), 0, "first", "launch", &principal).await, Err(StoreError::Conflict(_))));
    assert!(matches!(store.apply_feature_policy(p.clone(), 0, "first", "other reason", &principal).await, Err(StoreError::Conflict(_))));
    next.revision = 1;
    let second = store.apply_feature_policy(next.clone(), 1, "second", "pause", &principal).await.unwrap();
    assert_eq!(second.revision, 2);
    assert_eq!(store.apply_feature_policy(p.clone(), 0, "first", "launch", &principal).await.unwrap(), first);
    let audit = admin.query_one(
        "SELECT old_revision, new_revision, principal, reason, summary, document FROM deployment_feature_policy_audit WHERE operation_id='second'", &[],
    ).await.unwrap();
    assert_eq!(audit.get::<_, i64>(0), 1);
    assert_eq!(audit.get::<_, i64>(1), 2);
    assert_eq!(audit.get::<_, String>(2), principal);
    assert_eq!(audit.get::<_, String>(3), "pause");
    let summary: serde_json::Value = audit.get(4);
    assert_eq!(summary["changed_fields"], serde_json::json!(["phase", "revision"]));
    assert!(summary.to_string().len() <= 4096);
    assert_eq!(audit.get::<_, serde_json::Value>(5), serde_json::json!(second));
    // Make only the second write (the audit insert) fail. The policy upsert
    // must roll back, and the operation id must remain available for a retry.
    admin.batch_execute("ALTER TABLE deployment_feature_policy_audit ADD CONSTRAINT injected_audit_failure CHECK (reason <> 'fail audit')").await.unwrap();
    assert!(matches!(store.apply_feature_policy(p.clone(), 2, "atomic", "fail audit", &principal).await, Err(StoreError::Database(_))));
    assert_eq!(store.feature_policy(FeatureKey::SharedChat).await.unwrap(), Some(second.clone()));
    assert_eq!(admin.query_one("SELECT count(*) FROM deployment_feature_policy_audit", &[]).await.unwrap().get::<_, i64>(0), 2);
    let third = store.apply_feature_policy(p.clone(), 2, "atomic", "retry audit", &principal).await.unwrap();
    assert_eq!(third.revision, 3);
    assert_eq!(store.feature_policies().await.unwrap(), vec![third]);
    let mut changed_feature = p.clone();
    changed_feature.feature_key = FeatureKey::EnvironmentBinding;
    assert!(matches!(store.apply_feature_policy(changed_feature, 0, "first", "launch", &principal).await, Err(StoreError::Conflict(_))));
    // Concurrent retries of one operation produce only one audit record.
    let (replay_a, replay_b) = tokio::join!(
        store.apply_feature_policy(p.clone(), 0, "first", "launch", &principal),
        store.apply_feature_policy(p.clone(), 0, "first", "launch", &principal),
    );
    assert_eq!(replay_a.unwrap(), first);
    assert_eq!(replay_b.unwrap(), first);
    // Simultaneous first applies serialize absent rows as well as existing rows.
    let mut another = p.clone();
    another.feature_key = FeatureKey::OrgGovernance;
    let (a, b) = tokio::join!(
        store.apply_feature_policy(another.clone(), 0, "race-a", "race", &principal),
        store.apply_feature_policy(another, 0, "race-b", "race", &principal),
    );
    assert!(matches!((&a, &b), (Ok(_), Err(StoreError::Conflict(_))) | (Err(StoreError::Conflict(_)), Ok(_))));
    assert_eq!(admin.query_one("SELECT count(*) FROM deployment_feature_policy_audit", &[]).await.unwrap().get::<_, i64>(0), 4);
    // Even the table owner cannot accidentally mutate historical audit rows.
    let error = admin.batch_execute("UPDATE deployment_feature_policy_audit SET reason='rewrite'").await.unwrap_err();
    assert_eq!(error.as_db_error().unwrap().message(), "deployment_feature_policy_audit is append-only");
    assert!(admin.batch_execute("TRUNCATE deployment_feature_policy_audit").await.is_err());
    drop((store, migrator, admin));
    admin_task.await.unwrap();
    database.cleanup_with_role(Some(&role)).await;
}

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL instance with role creation privileges"]
async fn rollout_app_tables_remain_select_only_after_every_boot() {
    let database = TestDatabase::create().await;
    let role = format!("rollout_app_{}", uuid::Uuid::new_v4().simple());
    let app_url = format!("{}&user={role}&password=synthetic", database.url);
    let (admin, connection) = tokio_postgres::connect(&database.url, NoTls).await.unwrap();
    let admin_task = tokio::spawn(async move { connection.await.unwrap() });
    for boot in 0..2 {
        let store = PgStore::connect_with_options(&app_url, 2, PgConnectOptions {
            migration_database_url: Some(&database.url), app_db_role: Some(&role),
            app_db_password: Some("synthetic"), ..PgConnectOptions::default()
        }).await.unwrap();
        assert!(store.feature_policies().await.unwrap().is_empty());
        let (app, connection) = tokio_postgres::connect(&app_url, NoTls).await.unwrap();
        let task = tokio::spawn(async move { connection.await.unwrap() });
        for table in ["deployment_feature_policies", "deployment_feature_policy_audit"] {
            app.query(&format!("SELECT * FROM {table}"), &[]).await.unwrap();
            let rls: bool = admin.query_one("SELECT relrowsecurity FROM pg_class WHERE oid=$1::text::regclass", &[&table]).await.unwrap().get(0);
            assert!(!rls);
            for query in [
                format!("INSERT INTO {table} (feature_key) VALUES ('shared-chat')"),
                format!("UPDATE {table} SET reason='forbidden'"),
                format!("DELETE FROM {table}"), format!("TRUNCATE {table}"),
            ] {
                let error = app.batch_execute(&query).await.unwrap_err();
                assert_eq!(error.code(), Some(&tokio_postgres::error::SqlState::INSUFFICIENT_PRIVILEGE));
                assert!(error.as_db_error().unwrap().message().contains("permission denied"));
            }
        }
        drop((app, store));
        task.await.unwrap();
        if boot == 0 {
            // Simulate a stray grant between boots; migrations must remove it.
            admin.batch_execute(&format!("GRANT ALL ON deployment_feature_policies, deployment_feature_policy_audit TO {role}")).await.unwrap();
        }
    }
    drop(admin);
    admin_task.await.unwrap();
    database.cleanup_with_role(Some(&role)).await;
}

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL instance with a superuser admin URL"]
async fn ownership_transfer_racing_offboard_has_one_winner_and_never_zero_owners() {
    use cognia_tenant_auth::OrgRole;
    use cognia_collab_server::store::StoreError;
    use std::time::Duration;
    let (database, store, owner, member, other_owner) = standing_fixture().await;
    let org = &owner.org_id;
    store.set_org_member(org, &other_owner.user_id, OrgRole::Owner, standing_context(&owner.user_id)).await.unwrap();
    let transfer = store.transfer_org_ownership(org, &member.user_id, OrgRole::Member, standing_context(&owner.user_id));
    let mut offboard_context = standing_context(&other_owner.user_id);
    offboard_context.source["expectedTargetOrgRole"] = serde_json::json!("owner");
    let offboard = store.offboard_org_member(org, &owner.user_id, offboard_context);
    let (transfer, offboard) = tokio::time::timeout(Duration::from_secs(10), async { tokio::join!(transfer, offboard) }).await.expect("no membership-lock deadlock");
    assert_eq!(usize::from(transfer.is_ok()) + usize::from(offboard.is_ok()), 1, "transfer={transfer:?}, offboard={offboard:?}");
    let caller_role = store.membership(org, &owner.user_id, None).await.unwrap().org_role;
    let target_role = store.membership(org, &member.user_id, None).await.unwrap().org_role;
    let remaining_owner = store.membership(org, &other_owner.user_id, None).await.unwrap().org_role;
    assert_eq!(remaining_owner, Some(OrgRole::Owner));
    if transfer.is_ok() {
        assert_eq!(caller_role, Some(OrgRole::Member));
        assert_eq!(target_role, Some(OrgRole::Owner));
        assert!(matches!(offboard, Err(StoreError::OwnershipConflict)));
    } else {
        assert!(matches!(transfer, Err(StoreError::OwnershipConflict)));
        assert!(caller_role.is_none());
        assert_eq!(target_role, Some(OrgRole::Member));
    }
    drop(store);
    database.cleanup().await;
}

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL instance with a superuser admin URL"]
async fn membership_mutations_recheck_actor_and_target_after_the_standing_barrier() {
    use std::{sync::Arc, time::Duration};
    use cognia_collab_server::store::StoreError;
    use cognia_tenant_auth::{OrgRole, WorkspaceRole};
    for (mutation, changed) in [
        ("patch", "target-promoted"), ("delete", "target-promoted"),
        ("patch", "actor-demoted"), ("delete", "actor-offboarded"),
        ("workspace-set", "actor-demoted"), ("workspace-remove", "actor-offboarded"),
        ("workspace-set", "workspace-target-promoted"), ("workspace-remove", "workspace-target-promoted"),
    ] {
        let (database, store, owner, target, carol) = standing_fixture().await;
        store.set_org_member(&owner.org_id, &carol.user_id, OrgRole::Owner, standing_context(&owner.user_id)).await.unwrap();
        let mut dave = bootstrap("standing_dave");
        dave.org_id = owner.org_id.clone();
        dave.logto_organization_id = owner.logto_organization_id.clone();
        dave.workspace_id = owner.workspace_id.clone();
        store.bootstrap_operator(&dave).await.unwrap();
        let workspace_target = changed == "workspace-target-promoted";
        store.set_org_member(&owner.org_id, &dave.user_id, if workspace_target { OrgRole::Member } else { OrgRole::Admin }, standing_context(&owner.user_id)).await.unwrap();
        store.set_workspace_member(&owner.org_id, &owner.workspace_id, &dave.user_id, if workspace_target { WorkspaceRole::Maintainer } else { WorkspaceRole::Viewer }, standing_context(&owner.user_id)).await.unwrap();
        if workspace_target {
            store.set_workspace_member(&owner.org_id, &owner.workspace_id, &target.user_id, WorkspaceRole::Member, standing_context(&owner.user_id)).await.unwrap();
        }
        // Snapshot authorization happens before either mutation is allowed to
        // take the standing barrier. The next operation invalidates it first.
        let before = store.membership(&owner.org_id, &dave.user_id, Some(&owner.workspace_id)).await.unwrap();
        assert_eq!(before.org_role, Some(if workspace_target { OrgRole::Member } else { OrgRole::Admin }));
        assert_eq!(store.membership(&owner.org_id, &target.user_id, None).await.unwrap().org_role, Some(OrgRole::Member));
        let store = Arc::new(store);
        let (gate, connection) = tokio_postgres::connect(&database.url, NoTls).await.unwrap();
        let gate_task = tokio::spawn(async move { connection.await.unwrap() });
        gate.query_one("SELECT pg_advisory_lock_shared(hashtextextended('cognia.collab.invite-standing:' || $1::text, 0))", &[&owner.org_id]).await.unwrap();
        let wait_for_blocked = |expected| {
            let gate = &gate;
            let name = &database.name;
            async move {
                tokio::time::timeout(Duration::from_secs(10), async {
                    loop {
                        let waiting: i64 = gate.query_one("SELECT count(*) FROM pg_stat_activity WHERE application_name=$1 AND wait_event='advisory'", &[name]).await.unwrap().get(0);
                        if waiting == expected { break; }
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                }).await.expect("mutation must wait on the membership standing barrier");
            }
        };
        let invalidate = {
            let store = store.clone(); let owner = owner.clone(); let target = target.clone(); let dave = dave.clone();
            tokio::spawn(async move {
                let context = standing_context(&owner.user_id);
                match changed {
                    "target-promoted" => store.transfer_org_ownership(&owner.org_id, &target.user_id, OrgRole::Member, context).await,
                    "actor-demoted" => store.set_org_member(&owner.org_id, &dave.user_id, OrgRole::Member, context).await,
                    "actor-offboarded" => store.offboard_org_member(&owner.org_id, &dave.user_id, context).await,
                    _ => store.set_workspace_member(&owner.org_id, &owner.workspace_id, &target.user_id, WorkspaceRole::Maintainer, context).await,
                }
            })
        };
        wait_for_blocked(1).await;
        let stale = {
            let store = store.clone(); let owner = owner.clone(); let target = target.clone(); let dave = dave.clone();
            tokio::spawn(async move {
                let context = standing_context(&dave.user_id);
                match mutation {
                    "patch" => store.set_org_member(&owner.org_id, &target.user_id, OrgRole::Member, context).await,
                    "delete" => store.offboard_org_member(&owner.org_id, &target.user_id, context).await,
                    "workspace-set" => store.set_workspace_member(&owner.org_id, &owner.workspace_id, &target.user_id, WorkspaceRole::Viewer, context).await,
                    _ => store.remove_workspace_member(&owner.org_id, &owner.workspace_id, &target.user_id, context).await,
                }
            })
        };
        wait_for_blocked(2).await;
        gate.query_one("SELECT pg_advisory_unlock_shared(hashtextextended('cognia.collab.invite-standing:' || $1::text, 0))", &[&owner.org_id]).await.unwrap();
        tokio::time::timeout(Duration::from_secs(10), invalidate).await.unwrap().unwrap().unwrap();
        let result = tokio::time::timeout(Duration::from_secs(10), stale).await.unwrap().unwrap();
        assert!(matches!(result, Err(StoreError::Forbidden)), "{mutation}/{changed}: {result:?}");
        assert_eq!(store.membership(&owner.org_id, &target.user_id, None).await.unwrap().org_role,
            Some(if changed == "target-promoted" { OrgRole::Owner } else { OrgRole::Member }));
        assert_eq!(store.membership(&owner.org_id, &target.user_id, Some(&owner.workspace_id)).await.unwrap().workspace_role, Some(WorkspaceRole::Maintainer));
        drop((gate, store));
        gate_task.await.unwrap();
        database.cleanup().await;
    }
}

fn admission_policy(key: cognia_collab_server::rollout::FeatureKey) -> cognia_collab_server::rollout::FeaturePolicy {
    use cognia_collab_server::rollout::{FeaturePolicy, Phase};
    FeaturePolicy {
        feature_key: key, schema_version: 1, revision: 0, phase: Phase::General, kill: false,
        allow_org_ids: vec![], deny_org_ids: vec![], deny_workspace_ids: vec![], percentage_basis_points: 10000,
        cohort_key: None, cohort_salt: "test".into(), hash_version: 1, minimum_contract_version: 2, requires: vec![],
    }
}

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL instance"]
async fn queue_claim_reads_committed_policy_after_waiting_on_session_lock_and_kill_refuses_claim() {
    use cognia_collab_server::{chat_store::{ChatStore, NewChatRunQueueItem}, rollout::{FeatureKey, FeatureReason, Phase}, store::StoreError};
    let (database, store, owner, _, _) = standing_fixture().await;
    let store = std::sync::Arc::new(store);
    store.enqueue_run_input(NewChatRunQueueItem {
        id: "admission_queue".into(), org_id: owner.org_id.clone(), workspace_id: owner.workspace_id.clone(),
        session_id: "standing_session".into(), requested_by_user_id: owner.user_id.clone(),
        payload: serde_json::json!({"messageId":"m"}), now: 2, operation_id: "admission_queue".into(),
    }).await.unwrap();
    let (mut locker, connection) = tokio_postgres::connect(&database.url, NoTls).await.unwrap();
    let task = tokio::spawn(async move { connection.await.unwrap() });
    let tx = locker.transaction().await.unwrap();
    tx.query_one("SELECT id FROM chat_sessions WHERE org_id=$1 AND id='standing_session' FOR UPDATE", &[&owner.org_id]).await.unwrap();
    let claimant = store.clone();
    let lease = standing_lease(&owner, &owner.user_id);
    let claim = tokio::spawn(async move { claimant.claim_run_queue(lease, "admission_queue", false).await });
    // Observe a real lock wait, rather than relying on a scheduler delay.
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            tx.batch_execute("SELECT pg_stat_clear_snapshot()").await.unwrap();
            let waiting: bool = tx.query_one(
                "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%chat_sessions%')", &[],
            ).await.unwrap().get(0);
            if waiting { break; }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }).await.expect("claim must be blocked on the held session lock");
    let mut policy = admission_policy(FeatureKey::SharedChatExecution);
    policy.phase = Phase::Paused;
    store.apply_feature_policy(policy.clone(), 0, "pause-during-claim", "test", "operator").await.unwrap();
    tx.commit().await.unwrap();
    let error = tokio::time::timeout(std::time::Duration::from_secs(5), claim).await.unwrap().unwrap().unwrap_err();
    assert!(matches!(error, StoreError::FeatureUnavailable(d) if d.reason == Some(FeatureReason::FeaturePaused)));
    assert_eq!(store.list_run_queue(&owner.org_id, "standing_session").await.unwrap()[0].status, "queued");
    policy.kill = true;
    store.apply_feature_policy(policy, 1, "kill-queue", "test", "operator").await.unwrap();
    let error = store.claim_run_queue(standing_lease(&owner, &owner.user_id), "admission_queue", false).await.unwrap_err();
    assert!(matches!(error, StoreError::FeatureUnavailable(d) if d.reason == Some(FeatureReason::FeatureKilled)));
    drop(locker);
    task.await.unwrap();
    drop(store);
    database.cleanup().await;
}

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL instance"]
async fn chat_and_canvas_contracts_are_pinned_and_old_clients_can_read_but_cannot_mutate() {
    use std::{sync::Arc, time::Duration};
    use axum::{body::{Body, to_bytes}, http::{Request, StatusCode}};
    use tower::ServiceExt;
    use cognia_collab_server::{AppState, router, chat_store::ChatStore, canvas_store::{CanvasStore, NewCanvasDocument}};
    use cognia_tenant_auth::{grant::{GrantSigner, GrantClaims}, oidc::TestAuthenticator, UserId, OrgId};
    let (database, store, owner, _, _) = standing_fixture().await;
    let store = std::sync::Arc::new(store);
    let session = store.admin_session(&owner.org_id, "standing_session").await.unwrap();
    assert_eq!(session.contract_version, 2);
    let document = store.create_document(NewCanvasDocument {
        id: "pinned_canvas".into(), org_id: owner.org_id.clone(), workspace_id: owner.workspace_id.clone(),
        title: "Pinned".into(), language: "text".into(), created_by_user_id: owner.user_id.clone(), created_at: 1, operation_id: "pinned_canvas".into(),
    }).await.unwrap();
    assert_eq!(document.contract_version, 2);
    let (admin, connection) = tokio_postgres::connect(&database.url, NoTls).await.unwrap();
    let task = tokio::spawn(async move { connection.await.unwrap() });
    admin.batch_execute("UPDATE chat_sessions SET contract_version=3 WHERE id='standing_session'; UPDATE canvas_documents SET contract_version=3 WHERE id='pinned_canvas'").await.unwrap();
    let signer = GrantSigner::new(&[9;32]).unwrap();
    let claims = GrantClaims::issue(UserId::parse(&owner.user_id).unwrap(), OrgId::parse(&owner.org_id).unwrap(), None, None, Duration::from_secs(300)).unwrap();
    let bearer = format!("Bearer {}", signer.sign(&claims).unwrap());
    let state = AppState::new(store.clone(), signer, Arc::new(TestAuthenticator))
        .with_chat_store(store.clone()).with_canvas_store(store.clone());
    for (path, feature) in [("chat-sessions/standing_session", "shared-chat"), ("canvas-documents/pinned_canvas", "canvas-collaboration")] {
        for (method, protocol, expected) in [("GET", 2, StatusCode::OK), ("PATCH", 2, StatusCode::FORBIDDEN), ("PATCH", 3, StatusCode::OK)] {
            let body = serde_json::json!({"title":"Edited", "operationId":"edit", "baseRevision":1});
            let response = router(state.clone()).oneshot(Request::builder().method(method).uri(format!("/v1/orgs/{}/{path}",owner.org_id))
                .header("authorization", &bearer).header("x-cognia-collab-protocol", protocol).header("content-type", "application/json")
                .body(Body::from(body.to_string())).unwrap()).await.unwrap();
            let status = response.status();
            let body: serde_json::Value = serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap();
            assert_eq!(status, expected, "{method} {path}: {body}");
            if status == StatusCode::FORBIDDEN {
                assert_eq!(body, serde_json::json!({"error":"feature_unavailable", "feature":feature, "state":"existing-only", "reason":"client_contract_unsupported"}));
            } else { assert_eq!(body["contractVersion"], 3); }
        }
    }
    drop((admin, state, store));
    task.await.unwrap();
    database.cleanup().await;
}

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL instance"]
async fn admission_reads_root_and_transitive_prerequisites_in_one_statement_snapshot() {
    use cognia_collab_server::{chat_store::{ChatStore, NewChatRunQueueItem}, rollout::{FeatureKey, FeatureReason, Phase}, store::StoreError};
    let (database, store, owner, _, _) = standing_fixture().await;
    let store = std::sync::Arc::new(store);
    store.enqueue_run_input(NewChatRunQueueItem {
        id:"snapshot_queue".into(),org_id:owner.org_id.clone(),workspace_id:owner.workspace_id.clone(),session_id:"standing_session".into(),
        requested_by_user_id:owner.user_id.clone(),payload:serde_json::json!({}),now:2,operation_id:"snapshot_queue".into(),
    }).await.unwrap();
    let mut root = admission_policy(FeatureKey::SharedChatExecution);
    root.requires = vec![FeatureKey::SharedChat];
    let mut middle = admission_policy(FeatureKey::SharedChat);
    middle.requires = vec![FeatureKey::CanvasCollaboration];
    let mut leaf = admission_policy(FeatureKey::CanvasCollaboration);
    leaf.phase = Phase::Paused;
    for policy in [root, middle, leaf] {
        let operation = policy.feature_key.as_str();
        store.apply_feature_policy(policy,0,operation,"test","operator").await.unwrap();
    }
    let (admin, connection) = tokio_postgres::connect(&database.url,NoTls).await.unwrap();
    let connection_task = tokio::spawn(async move { connection.await.unwrap() });
    // Pause the root row while it is being returned. The old per-row reader
    // then sees the new leaf on its next statement; a single statement keeps
    // the pre-flip leaf even though the writer commits before this row returns.
    admin.batch_execute(
        "ALTER TABLE deployment_feature_policies RENAME TO policy_snapshot_backing;
         CREATE FUNCTION policy_snapshot_gate(value jsonb, feature text) RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $$
         BEGIN
           IF feature='shared-chat-execution' THEN
             PERFORM pg_advisory_lock_shared(74127123);
             PERFORM pg_advisory_unlock_shared(74127123);
           END IF;
           RETURN value;
         END $$;
         CREATE VIEW deployment_feature_policies AS
           SELECT feature_key, policy_snapshot_gate(document,feature_key) AS document FROM policy_snapshot_backing;
         SELECT pg_advisory_lock(74127123);"
    ).await.unwrap();
    let claimant = store.clone();
    let lease = standing_lease(&owner,&owner.user_id);
    let claim = tokio::spawn(async move { claimant.claim_run_queue(lease,"snapshot_queue",false).await });
    tokio::time::timeout(std::time::Duration::from_secs(5),async {
        loop {
            let blocked: bool = admin.query_one(
                "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event='advisory')",&[],
            ).await.unwrap().get(0);
            if blocked { break; }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }).await.expect("root policy SELECT must reach the controlled interleaving");
    // Atomic flip: both before and after deny admission. Only the hybrid
    // root=general / leaf=general permits a claim.
    admin.batch_execute(
        "BEGIN;
         UPDATE policy_snapshot_backing SET document=jsonb_set(document,'{phase}','\"paused\"') WHERE feature_key='shared-chat-execution';
         UPDATE policy_snapshot_backing SET document=jsonb_set(document,'{phase}','\"general\"') WHERE feature_key='canvas-collaboration';
         COMMIT;
         SELECT pg_advisory_unlock(74127123);"
    ).await.unwrap();
    let result = tokio::time::timeout(std::time::Duration::from_secs(5),claim).await.unwrap().unwrap();
    assert!(matches!(result,Err(StoreError::FeatureUnavailable(d)) if d.reason == Some(FeatureReason::PrerequisiteUnavailable)),"claim must consume the pre-flip snapshot");
    assert_eq!(store.list_run_queue(&owner.org_id,"standing_session").await.unwrap()[0].status,"queued");
    drop((admin,store));
    connection_task.await.unwrap();
    database.cleanup().await;
}

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL instance"]
async fn killed_file_queue_skips_mkdir_and_delivers_list_stat_and_read_results_with_contract_checks() {
    use std::{sync::Arc,time::Duration};
    use axum::{body::{Body,to_bytes},http::{Request,StatusCode}};
    use tower::ServiceExt;
    use cognia_collab_server::{AppState,router,session_files::{SessionFileStore,FileHost,FileRequest,FileOp,RequestStatus,HOST_TOKEN_HEADER}};
    use cognia_tenant_auth::{grant::GrantSigner,oidc::TestAuthenticator};
    let (database, store, owner, _, _) = standing_fixture().await;
    let store = Arc::new(store);
    let host_token = "file-read-drain-token";
    use sha2::Digest;
    let hash = hex::encode(sha2::Sha256::digest(host_token.as_bytes()));
    store.put_host(FileHost { org_id:owner.org_id.clone(),workspace_id:owner.workspace_id.clone(),session_id:"standing_session".into(),registered_by:owner.user_id.clone(),
        host_token_hash:hash.clone(),host_label:"Host".into(),registered_at:1,last_seen_at:None }).await.unwrap();
    store.put_grant(cognia_collab_server::session_files::FileGrant {
        id:"g".into(),org_id:owner.org_id.clone(),workspace_id:owner.workspace_id.clone(),session_id:"standing_session".into(),label:None,user_ids:None,
        min_role:cognia_collab_server::chat::SessionRole::Viewer,permissions:vec!["read".into(),"download".into(),"write".into()],
        paths:vec![cognia_collab_server::session_files::GrantPath {path:"/workspace".into(),is_dir:true}],status:"active".into(),expires_at:1000,revoked_at:None,
        policy_revision:1,created_by:owner.user_id.clone(),created_at:1,updated_at:1,
    }).await.unwrap();
    let mut pending = FileRequest { id:"blocked_mkdir".into(),org_id:owner.org_id.clone(),workspace_id:owner.workspace_id.clone(),session_id:"standing_session".into(),grant_id:"g".into(),
        requester_user_id:owner.user_id.clone(),requester_role:cognia_collab_server::chat::SessionRole::Owner,op:FileOp::Mkdir,path:"/workspace/src/new".into(),dest_path:None,upload:None,
        status:RequestStatus::Pending,result:None,result_object:None,error:None,created_at:2,claimed_at:None,completed_at:None,expires_at:1000 };
    store.create_request(pending.clone()).await.unwrap();
    let mut policy = admission_policy(cognia_collab_server::rollout::FeatureKey::SharedChat);
    policy.kill = true;
    store.apply_feature_policy(policy,0,"kill-file-queue","test","operator").await.unwrap();
    let mut state = AppState::new(store.clone(),GrantSigner::new(&[9;32]).unwrap(),Arc::new(TestAuthenticator))
        .with_chat_store(store.clone()).with_session_files_store(store.clone());
    state.now = Arc::new(|| 10);
    let send = |state: AppState, path: String, body: Body, json: bool| {
        let host_token = host_token.to_owned();
        async move {
            let response = router(state).oneshot(Request::builder().method(if json {"POST"} else {"PUT"}).uri(path)
                .header("x-cognia-collab-protocol","2").header(HOST_TOKEN_HEADER,host_token)
                .header("content-type",if json {"application/json"} else {"application/octet-stream"}).body(body).unwrap()).await.unwrap();
            let status = response.status();
            (status,to_bytes(response.into_body(),usize::MAX).await.unwrap())
        }
    };
    for (index,op) in [FileOp::List,FileOp::Stat,FileOp::Read].into_iter().enumerate() {
        pending.id = format!("drain_{index}"); pending.op=op; pending.created_at=3+index as i64;
        store.create_request(pending.clone()).await.unwrap();
        let claimed = store.claim_next(&owner.org_id,"standing_session",&hash,10).await.unwrap().unwrap();
        assert_eq!(claimed.id,pending.id);
        let base = format!("/v1/orgs/{}/chat-sessions/standing_session/file-host/requests/{}",owner.org_id,claimed.id);
        let outcome = if op == FileOp::Read {
            let (status,bytes) = send(state.clone(),format!("{base}/result"),Body::from("a"),false).await;
            assert_eq!(status,StatusCode::NO_CONTENT,"{}",String::from_utf8_lossy(&bytes));
            serde_json::json!({"ok":true,"object":{"byteLength":1,"mediaType":"text/plain"}})
        } else { serde_json::json!({"ok":true,"result":{"entries":[]}}) };
        let (status,bytes) = send(state.clone(),format!("{base}/complete"),Body::from(outcome.to_string()),true).await;
        assert_eq!(status,StatusCode::NO_CONTENT,"{}",String::from_utf8_lossy(&bytes));
        let done = store.request(&owner.org_id,"standing_session",&claimed.id).await.unwrap().unwrap();
        assert_eq!(done.status,RequestStatus::Done);
    }
    assert!(store.claim_next(&owner.org_id,"standing_session",&hash,10).await.unwrap().is_none());
    assert_eq!(store.request(&owner.org_id,"standing_session","blocked_mkdir").await.unwrap().unwrap().status,RequestStatus::Pending);
    // Delivering a read is rollout-exempt, but still mutates stored state and
    // must respect the pinned contract on both bytes and completion routes.
    pending.id="old_reader".into(); pending.op=FileOp::Read; pending.created_at=8;
    store.create_request(pending.clone()).await.unwrap();
    store.claim_next(&owner.org_id,"standing_session",&hash,10).await.unwrap().unwrap();
    let (admin,connection)=tokio_postgres::connect(&database.url,NoTls).await.unwrap();
    let connection_task=tokio::spawn(async move {connection.await.unwrap()});
    admin.batch_execute("UPDATE chat_sessions SET contract_version=3 WHERE id='standing_session'").await.unwrap();
    let base=format!("/v1/orgs/{}/chat-sessions/standing_session/file-host/requests/old_reader",owner.org_id);
    let (status,bytes)=send(state.clone(),format!("{base}/result"),Body::from("a"),false).await;
    assert_eq!(status,StatusCode::FORBIDDEN);
    let body:serde_json::Value=serde_json::from_slice(&bytes).unwrap();
    assert_eq!(body["reason"],"client_contract_unsupported");
    drop((admin,state,store));
    tokio::time::timeout(Duration::from_secs(5),connection_task).await.unwrap().unwrap();
    database.cleanup().await;
}

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL instance and COLLAB_RLS_ADMIN_DATABASE_URL / COLLAB_RLS_APP_DATABASE_URL"]
async fn org_member_names_answer_only_this_orgs_members_in_postgres() {
    use cognia_collab_server::{store::OrgMemberName, Store};
    let (_database, store, owner, member, _guest) = standing_fixture().await;
    let outsider = bootstrap("names_outsider");
    store.bootstrap_operator(&outsider).await.unwrap();
    let names = store
        .org_member_names(
            &owner.org_id,
            &[member.user_id.clone(), outsider.user_id.clone(), owner.user_id.clone()],
        )
        .await
        .unwrap();
    // Ordered by id; the user of another org is not confirmed to exist.
    assert_eq!(
        names,
        vec![
            OrgMemberName { user_id: member.user_id.clone(), display_name: member.user_name.clone() },
            OrgMemberName { user_id: owner.user_id.clone(), display_name: owner.user_name.clone() },
        ]
    );
    assert!(store.org_member_names(&owner.org_id, &[]).await.unwrap().is_empty());
}
