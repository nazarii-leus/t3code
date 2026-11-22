# Claude

T3 Code uses Claude Code's login and configuration. Start with the default provider
for one account; [provider setup](./install.md#providers) covers installation and
shared provider settings.

## Accounts

One Claude folder (`~/.claude`, or the provider's **Claude folder**) can hold several Claude
accounts. Open **Settings > Providers > Claude**. **Accounts** lists them; one is active at a
time, and it runs every Claude thread and Claude in terminals on that machine. Everything else in
the folder is shared by all accounts: rules, settings, skills, plugins, MCP servers and their
sign-ins, and conversations, so a thread continues with its history after a switch.

- **Add account** signs in on Claude's page. The page signs in the account your browser is using,
  so open the link in a private window to add a different one. When T3 Code runs on another
  machine, the browser cannot reach the final localhost page; paste that page's address into the
  sign-in panel. A new account becomes active only when no account is; otherwise choose **Use**.
- **Use** makes an account active. When Claude threads are working, a confirmation names them:
  each finishes its current step, then continues on the new account. It also says when the account
  can't run a model in use or is out of usage.
- Each row shows the account's plan, its status and its usage windows: the 5-hour window, the
  weekly window and each model's weekly window, such as Fable. **Check usage** reads them again.
- A sign-in lasts about 30 days. The row warns five days before it ends; **Sign in again** renews it.
- The menu also offers **Rename**, **Leave out of automatic switching**, and **Remove**, which
  signs the account out on this machine. Threads and their history stay.

With **Switch accounts at usage limits** on, T3 Code makes the next account active when the
active one runs out of usage and continues the stopped threads (see [Usage limits](#usage-limits)).
The Accounts section shows which account is next and the last switches.

Switching needs Claude Code 2.1.328 or a later 2.1 release, on Linux. On macOS, Claude keeps its login in the
Keychain, and on Windows T3 Code can't sign Claude in yet, so there T3 Code manages one Claude
account and the list shows why. On mobile, **Settings > Providers > Claude** offers the same list.

Earlier versions of this fork kept each extra account in its own folder under `~/.claude-accounts`.
On the first start of this version on Linux, each such account becomes an entry of the main Claude
provider's list, keeping its name; its old provider id keeps working for existing threads, and the
previous settings are saved next to `settings.json` as `settings.json.bak-claude-accounts`. An
account whose login can't be moved at that moment stays a separate provider until the next start.

## MCP servers

**Settings > Providers > Claude > MCP servers** lists the MCP servers Claude itself is configured
with: your own servers, the selected project's `.mcp.json` and local servers, servers from plugins,
claude.ai connectors and servers your organization sets. Pick a project at the top of Settings to
see its servers. Each row shows whether the server is connected and how many tools it offers,
needs a sign-in, failed to connect, or is off in the project.

- **Add server** adds a remote (HTTP or SSE) server or a local command, for all your projects, for
  the project only for you, or shared with the team through `.mcp.json`. Header and environment
  values stay on the machine and are never shown again.
- **Sign in** signs Claude in to a server that needs it. Sign-ins are shared by all accounts.
- **Reconnect in running threads** applies a sign-in to threads that are already running; other
  threads pick up changes when they start.
- **Turn off in this project**, **Edit** and **Remove** change Claude's own configuration. Servers
  from plugins, claude.ai and your organization are managed there and can't be edited here.

## Separate configurations

For a completely separate configuration, such as a preset with different settings or a router
connection, give a Claude provider its own folder. On the environment's machine, create the login:

```bash
mkdir -p ~/.claude_personal
CLAUDE_CONFIG_DIR=~/.claude_personal claude auth login
```

Then choose **Configure manually** when you add the Claude provider and set its **Claude folder**:

| Instance        | Binary path | Claude folder        |
| --------------- | ----------- | -------------------- |
| Claude Work     | `claude`    | Leave empty          |
| Claude Personal | `claude`    | `~/.claude_personal` |

An empty folder uses Claude Code's normal configuration. The setting changes `CLAUDE_CONFIG_DIR`,
leaving `HOME` and the system keychain location intact. Use the same variable for the login
command. Setting `HOME` instead can put credentials where this provider will not find them. A
separate folder has its own accounts and conversations: a thread that moves to it starts a new
session and receives a handoff of the recent conversation. Two Claude providers can't use the
same folder: the second one says so and signs no account in.

For presets that differ only in API keys or endpoints, use the instance's
**Environment variables**. Variable assignments do not belong in **Launch arguments**.

File paths in the `--settings` and `--append-system-prompt-file` launch arguments
can start with `~` for the home directory of the machine running T3 Code. Any
other relative path is read from the thread's project folder, or its worktree.

Claude Code's verbose mode can stay enabled when you use Claude for text generation, including
thread titles, branch names, commit messages, and pull request descriptions. On a remote connection,
T3 Code uses the Claude configuration on the connected server.

## Compact long conversations

Set **Auto-compact after** in the Claude provider settings to an integer between
`100000` and `1000000`. For example, `300000` asks Claude to summarize at about
300,000 tokens. This changes when compaction happens, not the model's context
window. Leave it empty for Claude Code's default.

You can also send `/compact` in an existing conversation. Claude Code also
compacts automatically. To see context usage, see
[commands and skills](./composer.md#commands-and-skills).

When you return to a large thread after Claude's prompt cache expires, a
**Compact** chip with the thread's token count shows
next to the send button. While it is on, Enter summarizes the history first, then
sends your message. Click the chip to switch it to **Keep** and keep the full
history for that message. The mobile app shows no chip: an eligible message sent
from it summarizes first. The cache lasts about an hour on a Claude
subscription and 5 minutes with an API key, Bedrock, or Vertex. See [commands and skills](./composer.md#commands-and-skills) for using
composer commands.

**Compact idle threads** in **Settings > Providers > Advanced** controls this for threads
over 200,000 tokens. Each Claude provider's settings can override it:

- **When you return** shows the **Compact** chip described above. This is the default.
- **Before the cache expires (beta)** tries to compact an idle thread shortly before its
  prompt cache expires, while the history is still cached.
  The compaction appears in the thread as a `/compact` turn sent by T3 Code.
  If the window is missed, such as when you enable this mode after the cache has
  expired or the server restarts before compaction runs, it falls back to
  **When you return**. Switch the chip to **Keep** to keep the full history for that message.
- **Never** skips idle compaction and Claude's resume prompt. **Auto-compact after**
  still applies, and you can still compact by hand.

## Usage limits

If your Claude subscription runs out of usage mid-turn, the thread shows which
limit was reached and the remaining wait when Claude provides a reset time.
Claude Code holds the turn until that window reopens, so it can keep showing as
working. Wait for the reset, or stop the turn and continue later. The warning's
timestamp shows when the displayed wait started. With
[Switch accounts at usage limits](./thread-sidebar.md#inspect-agent-work) on, T3 Code
makes the next signed-in account with usage left active, and every Claude thread
moves to it; the threads that stopped on the limit continue. A turn Claude holds
moves once it stops, which can take 10 minutes. To move it sooner, stop it and send
your next message. With the setting off, the composer offers **Switch Claude to** the
next account instead. T3 Code switches at most 5 times an hour, then pauses
automatic switching for the hour; **Resume now** in the Accounts section ends the pause.

## Skills

Claude skills come from the config directory's `skills` folder and the project's
`.claude/skills` folder. If both define the same name, the config-directory copy
wins. Skills disabled in Claude's settings do not appear in the composer.

Use `$` in the composer to select a skill. Enabled installed Claude plugins,
and plugins synced from your claude.ai account, also contribute skills under
names such as `plugin:review`. Skills marked `disable-model-invocation` can
still be started by you. Invoke those one per message: Claude directly runs only
the last named skill and may try to start earlier ones through its Skill tool,
which refuses skills reserved for manual invocation.

## Task lists

To show Claude task lists in the web and desktop apps, add
`CLAUDE_CODE_ENABLE_TODO_TOOLS=1` under **Variables** in the Claude instance's
**Environment** section in **Settings > Providers**. Each update shows as a Tasks
row in the thread; open it to see every step.

## Claude in Chrome

Claude threads can use the Claude in Chrome extension, which works in your own
Chrome with its sign-ins. T3 Code sessions load it only when asked: add `--chrome`
to **Launch arguments** in the Claude instance's settings in **Settings > Providers**.
It applies to sessions that start after you save. Set up the extension as you would
for Claude Code first; see Claude Code's [Chrome guide](https://code.claude.com/docs/en/chrome).

The instance must be signed in with `/login` on a direct Anthropic plan. Instances
that use an API key or a `claude setup-token` token don't get it, even with
`--chrome`, and neither do third-party providers such as Amazon Bedrock. Claude Code
doesn't support it in WSL.

## OpenRouter

Create a Claude instance with its own config directory, such as
`~/.claude_openrouter`, and keep **Binary path** set to `claude`. In that instance's
**Environment variables**, use:

| Variable               | Value                                     |
| ---------------------- | ----------------------------------------- |
| `ANTHROPIC_BASE_URL`   | `https://openrouter.ai/api`               |
| `ANTHROPIC_AUTH_TOKEN` | Your OpenRouter API key, marked Sensitive |
| `ANTHROPIC_API_KEY`    | An explicitly empty value                 |

If that Claude config directory has a cached Anthropic login, run `/logout` in a
Claude Code session using that directory before starting the router setup. Cached
login credentials can conflict with the router token.

Select the model you want in T3 Code. For an OpenRouter model outside the built-in
list, open that Claude instance in **Settings > Providers** and add its full model
ID with **Add custom model**. Then select it in the chat model picker.
`ANTHROPIC_DEFAULT_*_MODEL` variables map Claude Code aliases such as `sonnet`; they
do not replace the explicit model ID selected in T3 Code. Custom models may have
fewer effort, thinking, or context controls than built-in models.

Verify the model used in OpenRouter's activity dashboard. For current compatibility
requirements, use the
[OpenRouter Claude Code guide](https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration).

## Other routers

A local router uses an ordinary Claude provider instance. Give it a separate
config directory and put the router's endpoint and credential variables in that
instance's **Environment variables**. The router must run where the environment
can reach it. Follow the [Claude Code Router instructions](https://github.com/musistudio/claude-code-router)
for its installation and routing configuration.
