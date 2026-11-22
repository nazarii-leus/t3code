# Claude accounts in one folder

A Claude provider instance owns one Claude folder (its `homePath`, or `~/.claude`). Several Claude
accounts share that folder: settings, skills, plugins, MCP servers and their sign-ins, and
conversations stay in it, and a switch replaces only the login. Users see this in
[Claude accounts](../user/providers-claude.md#accounts).

## The login set and the store

Claude Code keeps an account's login in two files of the folder. The keys Claude removes on
`claude auth logout` are the login set ([`CLAUDE_LOGIN_KEYS`](../../apps/server/src/provider/claudeAccounts/ClaudeAccountStore.ts)):
`claudeAiOauth`, `organizationUuid`, the trusted-device and enterprise-gateway keys, and the
design and cloud-session sign-ins. `mcpOAuth` and `pluginSecrets` are not in it: they belong to
the folder, so MCP sign-ins survive a switch.

Accounts that are not active live in a store under the server's state directory:
`<stateDir>/provider-accounts/claude/<sha256(realpath(folder))[:12]>/`. It holds `index.json`
(accounts in their display order, names, automatic-switch flags, history, pause and limit
marks), `<accountId>/{.credentials.json,.claude.json}` with each stored login set, `journal.json`
while a switch runs, and scratch folders for sign-ins. An account id is
`<accountUuid>.<organizationUuid>`, so one email in two organizations gives two accounts.

## Switching

[`ClaudeAccountStore.switchTo`](../../apps/server/src/provider/claudeAccounts/ClaudeAccountStore.ts)
takes Claude's own locks, in Claude's order: the refresh lock (`<folder>/.oauth_refresh.lock`), the
legacy `<realpath(folder)>.lock`, and the storage-write lock. Under them it saves the outgoing
login set to the store, writes the incoming one into the folder with a temporary file and a rename,
and clears the incoming store copy. Claude reloads `.credentials.json` when its mtime changes, so
running sessions pick up the new login at their next request. The locks are held for well under
Claude's own retry window.

The store keeps exactly one copy of every refresh token: a rotated token in the folder is never
overwritten by an older store copy. `reconcile` runs at start and after a crash; it reads what the
folder holds and finishes or rolls back the switch the journal describes. The
[store tests](../../apps/server/src/provider/claudeAccounts/ClaudeAccountStore.test.ts) cover each
crash point.

Switching runs with Claude Code 2.1.328 or a later 2.1 release; another version turns it off until
checked. On macOS the login is in the Keychain and on Windows T3 cannot sign Claude in, so the
snapshot reports `supported: false` with a reason, and the provider's own sign-in is used there.

## The accounts service

[`makeClaudeAccounts`](../../apps/server/src/provider/claudeAccounts/ClaudeAccounts.ts) owns the
index and builds the `accounts` field of the Claude provider snapshot. Stored accounts are probed
by running Claude with the account's store folder as its config folder, so their usage windows and
models come from Claude itself; the active account's come from the provider's own probe. It watches the folder, so a login changed outside T3 (`claude auth
login` in a terminal) is adopted as the active account with the reason `outside`.

Sign-in uses the provider auth flow with the method ids `account:add` and `account:renew:<id>`:
Claude signs in inside a scratch folder, and `adoptSignIn` stores the login as a new or renewed
account. A new account becomes active only when no account is.

`switchForLimit` picks the next account for automatic switching
([`pickAccountSwitchTarget`](../../apps/server/src/provider/claudeAccounts/ClaudeAccounts.ts)):
an account that is ready, included in automatic switching, not marked limited, with no window
used up, and offering every model in use; among them, the soonest weekly reset first. More than
five automatic switches in an hour pause automatic switching for the hour.

## Usage limits and continuing threads

When a Claude run fails on a usage limit,
[`ThreadManagementService`](../../apps/server/src/orchestration-v2/ThreadManagementService.ts) asks
the accounts service to switch before a new turn starts, and the
[`UsageLimitRecoveryWorker`](../../apps/server/src/orchestration-v2/UsageLimitRecoveryWorker.ts)
continues stopped threads on the same instance. The continuation command carries
`usageLimitSwitchedAccount`, so the orchestrator does not hold it for the old account's reset. The
account a failed run used is derived from the switch history at the failure time; runs carry no
account field.

## Migration from account folders

Earlier versions kept each extra account in its own Claude folder whose `projects` linked into the
main folder's (or in a shadow home of the main folder). At start on Linux, after a backup of the
settings,
[`migrateClaudeAccountFolders`](../../apps/server/src/provider/claudeAccounts/ClaudeAccountsMigration.ts)
moves each such login into the main folder's store under the locks, keeps the instance's display
name and enabled flag as the account's name and automatic-switch flag, removes the instance, and
records `providerInstanceAliases` from its id to the main instance. The
[registry](../../apps/server/src/provider/ProviderInstanceRegistry.ts) resolves aliases, so stored
threads keep running; clients map them with `resolveProviderInstanceAlias`. The previous settings
are kept as `settings.json.bak-claude-accounts`. A login that can't be moved (Claude holds its lock,
the file can't be read) leaves its instance as it is for the next start. A Claude instance with its
own unlinked folder stays a separate provider with its own list; a second instance on a folder that
already has a provider gets no list and signs no account in (MCP sign-ins still work).

## MCP servers

[`makeClaudeMcpManager`](../../apps/server/src/provider/claudeMcp/ClaudeMcpManager.ts) lists the
servers Claude is configured with, from Claude's files, and checks them through an SDK query in the
selected project's folder. Saving runs `claude mcp add-json <name> - --scope <scope>` with the
JSON on stdin, so header and environment values never reach a command line; a failed save re-adds
the previous configuration. Sign-in uses the auth flow method `mcp:<key>` and runs
`claude mcp login` in a terminal. Reconnect calls the SDK's reconnect on every live Claude query of
the folder ([`liveClaudeQueries`](../../apps/server/src/provider/claudeMcp/liveClaudeQueries.ts)).
Server targets are redacted before they leave the server.
