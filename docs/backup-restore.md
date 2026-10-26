# Backup and recovery

Back up the whole PostgreSQL database, including BYTEA media, immutable revisions/chunks/index sources, OAuth credential ciphertext, source cursors, agent grants, and audit rows. Keep CREDENTIAL_ENCRYPTION_KEY and any deployment secret-store recovery material separately; a database dump alone cannot decrypt provider credentials. Use encrypted backup storage and private file permissions.

For the local Compose database, these commands create a custom-format dump without placing a password on the command line:

```sh
umask 077
docker compose exec -T postgres pg_dump -U personal_context --format=custom --dbname=personal_context > personal-context.dump
```

Stop application workers before a planned recovery. Restore into a new empty database rather than overwriting the owner database. For a same-cluster recovery drill:

```sh
docker compose exec -T postgres createdb -U personal_context personal_context_recovery
docker compose exec -T postgres pg_restore -U personal_context --no-owner --exit-on-error --dbname=personal_context_recovery < personal-context.dump
```

The target server needs the compatible pgvector extension and the personal_context_reader / personal_context_audit NOLOGIN roles referenced by grants/policies. They already exist on this project's local cluster. Provision those roles separately before restoring onto a different cluster. Preserve ACLs; omitting them breaks restricted retrieval. Use the destination deployment's intended owner and least-privilege service-role memberships. Point a separate API/worker configuration at the restored database and supply the original credential encryption key. Do not start restored scheduled ingestion until deciding which environment should own live connections.

Verify representative media hashes and provider-credential decryption without printing secrets. Authenticate a restored agent and resolve an existing record/revision/chunk URI. Confirm owner login, source grants, task evidence, and database migrations. Expired worker leases can be reclaimed; live leases wait for expiry, preventing concurrent ownership. Old worker tokens cannot heartbeat or commit after recovery. Replay uses stable source IDs and immutable revision hashes.

Automated evidence: `npm run test:db:isolated` seeds fixture media and encrypted credentials, simulates lease expiry/restart, dumps its unique temporary database through the local pg17 container, restores into a second unique temporary database, and verifies exact citation identity, media bytes, credential decryption, and agent authentication. Both temporary databases are removed. This check is enabled for the local Compose test port 55439 and is skipped for unrelated database environments. It does not restore or replace the owner's database.
