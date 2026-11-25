# Security — do this first

The repository has been shipping `data/lattice-store.json` with live OAuth access tokens and refresh tokens inside it. Those tokens exist in git history. Removing the file from the index is **not** enough: anyone with a clone can read the old commits.

## Order of operations

1. **Rotate every token at the provider.** Kilo, Nous, Cline, DeepSeek and FreeLLMAPI tokens in the store must be revoked and reissued. Do this before anything else. Lattice cannot do it for you; it requires your accounts.
2. **Remove the store from the index** (keeps your local file):

   ```bash
   git rm --cached data/lattice-store.json
   ```

3. **Scrub the history** with `git filter-repo` (destructive, rewrites every commit; back up the repo first):

   ```bash
   git filter-repo --path data/lattice-store.json --invert-paths
   ```

   Then force-push to every remote you control and tell collaborators to re-clone. If you do not want a history rewrite, treat every token that was ever committed as compromised and keep them rotated forever — the file stays readable in old commits.
4. **Only then** add new accounts through the dashboard. The store is now git-ignored.

## Hardening that ships with this tree

- The gateway token and admin token are generated on first run and persisted in `data/lattice-auth.json` (0600), so they survive restarts. Only a non-reversible SHA-256 fingerprint is printed at startup — the raw tokens are never printed. Rotate by deleting that file and restarting. Send them as `Authorization: Bearer <token>`.
- CORS defaults to explicit loopback origins. Cross-origin browser requests carrying a foreign `Origin` are rejected.
- OAuth status responses no longer contain account credentials.
- The launchers no longer kill unrelated processes holding port 4000.
- Upstream `baseUrl` values are allow-listed so a crafted account cannot turn Lattice into an internal-network proxy.
- There is no silent local sync. The old `POST /api/accounts/sync-local` endpoint, which read two hardcoded personal paths and embedded emails in account IDs, has been removed.
- Importing accounts is a two-step consent flow: `POST /api/accounts/import/preview` with an explicit `source` and `path` returns only provider/count redaction, then `POST /api/accounts/import/confirm` with the short-lived token actually imports. `path` must resolve inside the staging directory (`data/imports/`, override with `LATTICE_IMPORT_DIR`); paths elsewhere on disk and symlinks escaping the directory are rejected. Preview never exposes tokens, emails, or raw account IDs; imported accounts get opaque random IDs.
- Secrets are separated from account metadata in `data/lattice-secrets.json` (0600) by default. On load, any plaintext credential still stored on an account is moved into the secret store and rewritten out of `data/lattice-store.json`. `GET /api/secrets/availability` honestly reports `file-fallback` in that mode; there is no fake keychain claim.
- With `LATTICE_SECRET_BACKEND=keychain`, secrets move to the OS store: Windows DPAPI (`os-dpapi`), macOS Keychain or Linux libsecret (`keychain`). A probe must pass before that label is reported; failures fall back to the 0600 file.

## Reporting

If you find a credential or a security regression, rotate first, then open an issue with the file and line — do not paste tokens into the issue.
