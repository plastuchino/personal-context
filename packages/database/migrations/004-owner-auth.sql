CREATE TABLE owner_account (id boolean PRIMARY KEY DEFAULT true CHECK(id), password_hash text NOT NULL);
CREATE TABLE owner_sessions (
 token_digest text PRIMARY KEY, csrf_digest text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL
);
CREATE TABLE login_attempts (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, occurred_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX login_attempts_time ON login_attempts(occurred_at);
CREATE TABLE encrypted_credentials (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ciphertext text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE source_accounts ADD FOREIGN KEY(credential_ref) REFERENCES encrypted_credentials(id);
CREATE TABLE oauth_states (
 digest text PRIMARY KEY, session_digest text NOT NULL REFERENCES owner_sessions(token_digest) ON DELETE CASCADE,
 provider text NOT NULL, expires_at timestamptz NOT NULL, verifier_ciphertext text
);
