use cognia_collab_server::{OperatorBootstrap, PgStore};
use tokio_postgres::{Client, NoTls};

const APP_ROLE: &str = "cognia_rls_app";

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
}

async fn assert_force_rls(client: &Client) {
    let rows = client
        .query(
            "SELECT relname, relrowsecurity, relforcerowsecurity \
             FROM pg_class WHERE relname = ANY($1) ORDER BY relname",
            &[&vec![
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
    assert_eq!(rows.len(), 6);
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
             priority, created_by_kind, created_by_id, created_at, updated_at) \
             VALUES ('issue_rls', 'org_a', 'workspace_a', 'project_a', 'safe', 'open', \
             'medium', 'human', 'usr_a', 10, 10)",
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
             priority, created_by_kind, created_by_id, created_at, updated_at) \
             VALUES ('issue_cross', 'org_b', 'workspace_b', 'project_b', 'blocked', 'open', \
             'medium', 'human', 'usr_b', 10, 10)",
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
             priority, created_by_kind, created_by_id, created_at, updated_at) \
             VALUES ('issue_fk', 'org_a', 'workspace_b', 'project_a', 'blocked', 'open', \
             'medium', 'human', 'usr_a', 10, 10)",
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
