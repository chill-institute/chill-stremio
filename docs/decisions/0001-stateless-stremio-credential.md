# 0001 Stateless Stremio credential

Status: accepted 2026-09-23. Implementation is tracked in the
[workspace plan](https://github.com/chill-institute/workspace/blob/main/docs/plans/2026-09-23-stremio-stateless-credential.md)
and [workspace #22](https://github.com/chill-institute/workspace/issues/22).

## Context

Stremio add-ons carry identity only in the install URL, which Stremio stores on
its servers. The hosted adapter maps a random capability in that URL to the
user's ordinary chill bearer, sealed in SQLite. That bearer embeds the raw
put.io token and never expires, so the adapter database and its key together
expose full put.io access for every connected user.

## Decision

- Engine issues a Stremio credential through `IssueStremioCredential`,
  authenticated with the ordinary chill bearer. It is a PASETO v4.local token on
  its own key set with key IDs, carrying the user's chill-app put.io token, the
  download folder, and a revocation epoch.
- The install URL carries the credential. The adapter forwards it in
  `X-Chill-Stremio-Credential` and stores no credential.
- Engine accepts the credential only for an allowlist of `UserService`
  procedures. Stremio `AddTransfer` accepts only Engine-issued download-token
  URLs and targets the credential folder without writing settings.
- The same chill put.io app and the user's normal settings apply. Disconnect
  increments an epoch under a `chill_stremio` key in the user's put.io config,
  ending every Stremio link without ending web or CLI sessions.
- Reads stay account-wide, credentials do not expire, and per-link revoke is a
  follow-up.
- Existing `/i/` installations keep working for 30 days after an in-Stremio
  notice, then their sealed bearers are deleted.

This reverses the earlier policy that Engine and contracts introduce no
client-specific credential, and #22's original chain through the chill token
and its exclusion of Disconnect.

## Consequences

- A leaked link grants account-wide reads, streaming, and Engine-issued
  acquisitions until Disconnect or key rotation.
- A leaked credential key exposes every link's put.io token; only revoking
  chill's put.io access stops direct use of a decrypted token.
- Acquisition claims remain the adapter's only per-user state, keyed by an
  opaque owner ID.
