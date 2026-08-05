# ProjectMind desktop agent (v0.2.3) - Advanced Documentation

Long-running **macOS / Windows / Ubuntu** CLI that:

1. Heartbeats computer name + platform via `reportAgentHeartbeat` (Agents page), including local LLM usage counters
2. Polls/claims **agent jobs** and implements tasks in an allowlisted local directory using:
   - **Auto** (`auto`, default) — `CURSOR_API_KEY` → Cursor SDK; else Cursor CLI; else Codex CLI; else Antigravity CLI; else Claude CLI; else Copilot CLI (falls through on startup failures)
   - **Cursor SDK** (`cursor_sdk`) — `@cursor/sdk` local agent
   - **Cursor CLI** (`cursor_cli`) — `agent` / Cursor Agent CLI (`-p --force --trust`)
   - **Codex CLI** (`codex_cli`) — `codex exec --json --sandbox workspace-write`
   - **Antigravity CLI** (`antigravity_cli`) — `agy -p … --dangerously-skip-permissions --mode accept-edits`
   - **Claude CLI** (`claude_cli`) — `claude -p … --output-format stream-json --dangerously-skip-permissions`
   - **Copilot CLI** (`copilot_cli`) — `copilot -p … --no-ask-user --allow-all`
   - **OpenRouter** (`openrouter`) — OpenRouter API with the cwd-scoped tool loop (explicit selection only)
   - **TokenRouter** (`tokenrouter`) — TokenRouter API with the cwd-scoped tool loop (explicit selection only)
   - **LLM API** (`llm_api`) — cwd-scoped tool loop

Jobs are created from the web **Agents** page (**Run task**) or from a project's **Tasks** page (**Execute** when a desktop agent is online). The agent never auto-runs todos.

## Download (commercial / end users)

Unsigned zip executables (no Node.js required) plus a **Node.js** cross-platform zip are published under `/downloads/agent/` and linked from **Agents → Connected Agents**. The Agents UI detects your OS and proposes the matching download first.

Build them locally:

```bash
npm run build:release
# → public/downloads/agent/projectmind-agent-macos-arm64.zip
# → public/downloads/agent/projectmind-agent-macos-x64.zip
# → public/downloads/agent/projectmind-agent-windows-x64.zip
# → public/downloads/agent/projectmind-agent-ubuntu-x64.zip
# → public/downloads/agent/projectmind-agent-nodejs.zip
# → public/downloads/agent/manifest.json
```

Native zips contain `projectmind-agent` (or `.exe`), a sample `.env` (production app URL + placeholders), `.env.example`, and a **platform-specific `README.txt`** (how to run on that OS). macOS zips also include `clear-quarantine.command`. The Ubuntu zip is a glibc Linux x64 binary (works on Ubuntu and most desktop Linux distros). The Node.js zip contains a bundled `projectmind-agent.cjs`, `package.json` (installs `@cursor/sdk`), sample `.env` / `.env.example`, `postinstall` hint, `start.command`, and its own `README.txt` — run `npm install && npm start` (Node.js **22.13+**; bare `npm run` only lists scripts).

| Package | How to run (see README.txt in the zip)                       |
| ------- | ------------------------------------------------------------ |
| macOS   | `./projectmind-agent` (clear quarantine first)               |
| Windows | `.\\projectmind-agent.exe`                                   |
| Ubuntu  | `chmod +x ./projectmind-agent && ./projectmind-agent`        |
| Node.js | `npm install && npm start` (Node 22.13+; not bare `npm run`) |

### macOS: "not allowed" / unidentified developer

Builds are **unsigned**, so Gatekeeper often blocks the binary after download (common on a Mac mini).

1. From the unzipped folder: `xattr -dr com.apple.quarantine .` — or double-click `clear-quarantine.command`.
2. If still blocked: **System Settings → Privacy & Security → Security → Open Anyway**, then confirm.
3. Or in Finder: Control-click `projectmind-agent` → **Open** → **Open**.

Long-term fix is Apple Developer ID signing + notarization (not in this release yet).

## Dev setup (from source)

```bash
cd mac-agent
cp .env.example .env
# edit .env — IMEMORY_API_KEY, IMEMORY_WORKSPACE_ALLOWLIST, and a runner key
npm install
```

Or reuse keys from the repo root `.env`.

### Required for job execution

| Variable                                 | Purpose                                                   |
| ---------------------------------------- | --------------------------------------------------------- |
| `IMEMORY_API_KEY`                        | Project/global API key                                    |
| `IMEMORY_WORKSPACE_ALLOWLIST`            | Comma-separated absolute roots (e.g. `/Users/you/work`)   |
| `IMEMORY_MANAGED_WORKSPACE_ROOT`         | Optional. Where the agent clones projects it owns (default `~/.imemory/workspaces`) |
| `CURSOR_API_KEY`                         | For `cursor_sdk` (required) and optional for `cursor_cli` |
| `CODEX_API_KEY` / `OPENAI_API_KEY`       | For `codex_cli` (or use `codex login`)                    |
| `ANTHROPIC_API_KEY`                      | For `claude_cli` (or use `claude` login)                  |
| `COPILOT_GITHUB_TOKEN` / `GH_TOKEN`      | For `copilot_cli` (or use `copilot` login)                |
| `OPENROUTER_API_KEY`                     | For agent jobs using the explicit `openrouter` runner     |
| `TOKENROUTER_API_KEY`                    | For agent jobs using the explicit `tokenrouter` runner    |
| `OPENAI_API_KEY` / `IMEMORY_LLM_API_KEY` | For `llm_api` jobs                                        |

### Agent-managed workspaces

When a project's directory is handed to this agent (in ProjectMind: Project
settings → Integrations → GitHub → "let the agent create a directory"), the agent
creates it under `IMEMORY_MANAGED_WORKSPACE_ROOT`
(default `~/.imemory/workspaces/<project-slug>`) on the first job:

- **The project has a repository** → `git clone`, then `fetch` + `reset --hard`
  on every later job. Works with any credential ProjectMind can resolve: a
  GitHub App installation, a user's OAuth connection, or a project PAT.
- **The project has no repository** → `git init` on an empty directory. Nothing
  is pushed; commits stay local and later jobs reuse the same tree untouched.

- The managed root is trusted implicitly, so it does **not** need to be added to
  `IMEMORY_WORKSPACE_ALLOWLIST`.
- The root always comes from this agent's own environment. The control plane
  sends a leaf path, which is validated against the local root before anything
  is written — a server-supplied root is never honoured.
- Git and `gh` authenticate with a short-lived token supplied per job, so the
  machine needs no ssh key and no `gh auth login`. The token is passed through
  the environment only: it never reaches `.git/config`, argv, or the logs.
- A managed checkout with a remote is agent-owned and is hard-reset before every
  job. Never point managed mode at a directory holding work you care about; if the
  path exists but is not a git repository, the agent refuses rather than deleting
  it. A local-only (`git init`) workspace is never reset — it holds the only copy.

Install CLIs on PATH when using those runners:

- Cursor Agent CLI: `agent` (also often installed as `cursor-agent`)
- Codex CLI: `npm i -g @openai/codex` → `codex`
- Antigravity CLI: install `agy` (https://antigravity.google) and sign in once
- Claude Code CLI: install `claude` (https://code.claude.com) and sign in once (or set `ANTHROPIC_API_KEY`)
- Copilot CLI: install `copilot` (https://docs.github.com/en/copilot/how-tos/copilot-cli) and sign in once

Override binaries with `IMEMORY_CURSOR_CLI_BIN` / `IMEMORY_CODEX_CLI_BIN` / `IMEMORY_ANTIGRAVITY_CLI_BIN` / `IMEMORY_CLAUDE_CLI_BIN` / `IMEMORY_COPILOT_CLI_BIN` if needed.

Paths outside the allowlist (including symlink escapes) are rejected.

## LLM usage statistics

After each runner invocation the agent increments a local counter keyed by `runner/model` (default file: `~/.imemory/desktop-agent-llm-usage.json`). Heartbeats attach the totals in `meta.llmUsage`, which the Agents page shows under **LLM usage**.

Override the file path with `IMEMORY_LLM_STATS_PATH`.

## Provider pacing

The agent paces outbound coding-agent calls so providers are less likely to rate-limit or block automated usage:

- **Min gap + jitter** between invokes (`IMEMORY_PROVIDER_MIN_GAP_MS`, `IMEMORY_PROVIDER_GAP_JITTER_MS`)
- **Cooldown** after 429 / `resource_exhausted` (honors `Retry-After` when present; else `IMEMORY_PROVIDER_COOLDOWN_MS`)
- **Soft RPM caps** per provider (`IMEMORY_CURSOR_MAX_RPM`, `IMEMORY_CODEX_MAX_RPM`, `IMEMORY_ANTIGRAVITY_MAX_RPM`, `IMEMORY_CLAUDE_MAX_RPM`, `IMEMORY_COPILOT_MAX_RPM`, `IMEMORY_OPENROUTER_MAX_RPM`, `IMEMORY_TOKENROUTER_MAX_RPM`, `IMEMORY_LLM_API_MAX_RPM`)
- **Prefer authenticated** Cursor SDK when `CURSOR_API_KEY` is set (`IMEMORY_PREFER_AUTHENTICATED=1`)
- **Capacity-aware order** in auto cascade (skip cooling-down runners; prefer least-recently-used)

Pacing decisions are logged on the job (`pacing waitMs=… reason=min_gap|rpm|cooldown`) and persisted with usage stats / heartbeat `meta.llmUsage.pacing`.

## Claude usage-limit awareness

Before invoking `claude_cli`, the agent runs `claude -p "/usage" --output-format json` (throttled to once per 5 minutes) and checks the reported session/week usage percentages:

- If either is at or above `IMEMORY_CLAUDE_USAGE_LIMIT_PERCENT` (default `90`), the agent puts `claude_cli` into a local cooldown (`IMEMORY_CLAUDE_USAGE_COOLDOWN_MS`, default 30 min) and falls through to the next runner in the cascade (or proceeds anyway if `claude_cli` was explicitly pinned with no fallback).
- The check result is logged on the job and included in heartbeats (`meta.claudeUsage`), which the server records on the shared **Models** tab (Agents page → Model Cooldowns → Usage column) so limits are visible without opening a terminal.

Override the `claude` binary with `IMEMORY_CLAUDE_CLI_BIN` (shared with the runner itself).

## Run

Start the ProjectMind app (so `/api/mcp` is up), then:

```bash
npm start
# or from repo root:
npm run mac-agent
```

Heartbeats every 60s; job poll every 5s (override with `IMEMORY_*_INTERVAL_MS`).

## Auto-update

Packaged installs (native zip **and** Node.js zip) periodically fetch `/downloads/agent/manifest.json` from the same ProjectMind origin as `IMEMORY_MCP_URL`. When a newer version is published, the agent downloads the matching zip, replaces its files (preserving `.env`), runs `npm install` for the Node.js package, and restarts.

| Variable                        | Purpose                                                 |
| ------------------------------- | ------------------------------------------------------- |
| `IMEMORY_AGENT_AUTO_UPDATE`     | Set to `0` / `false` to disable (default: on)           |
| `IMEMORY_AGENT_UPDATE_CHECK_MS` | Min ms between checks (default: 6 hours; min 60000)     |
| `IMEMORY_AGENT_UPDATE_URL`      | Optional download base URL (default: origin of MCP URL) |

Source checkouts (`npm start` from `mac-agent/`) only report version; they do not self-replace the repo.

Open **Agents** → pick an online agent → **Run task** → choose **any** project and an open task (local directory override is optional when a runtime project path is configured) → **Enqueue**.

Or open a project's **Tasks** page — when at least one Mac agent is online, each task shows **Execute** (cwd comes from the agent's runtime project path, or an explicit override).

Done tasks are hidden from the Run task picker. The Mac agent can claim jobs for any project even when its API key is scoped to one project.

After a **successful implement** job, if the workspace is a git repo with uncommitted changes, the agent:

1. Stages changes (`git add -A`)
2. Commits with a short message derived from the runner summary (what was done)
3. Pushes to the remote (`git push`, or `git push -u origin HEAD` if needed)

**Plan phase:** ambiguous/complex tasks may queue with `phase=plan`. The agent proposes a plan or clarifying questions, then sets the job to `awaiting_user` (task stays open). Approve/answer/reject on the web **Agents** page; approve enqueues an implement follow-up job.

Skip git with `IMEMORY_AGENT_GIT_COMMIT=0` or commit-only with `IMEMORY_AGENT_GIT_PUSH=0`. Sensitive paths (e.g. `.env`) are refused. Git failures are logged into the job result but do not flip a successful run to failed.

## Safety

- Only explicitly enqueued jobs run
- One active job per agent (claim + lease)
- Enqueue requires a recent heartbeat on the job project or another project the actor can access (not any online key globally)
- Claim/lifecycle reject spoofed keys whose latest heartbeat is outside the API key scope
- Prefer `IMEMORY_AGENT_KEY` (opaque) over default `host:<ComputerName>` on shared deployments
- Workspace allowlist + realpath checks before any runner (and for `llm_api` file tools)
- Cursor/Codex/LLM API keys stay in local `.env` (never put on argv; spawn logs redact secrets)
- Cursor CLI uses `--force --trust` for headless automation; Codex uses `--sandbox workspace-write`
- Antigravity CLI uses `--dangerously-skip-permissions` (set `IMEMORY_ANTIGRAVITY_SKIP_PERMISSIONS=0` to disable) and `--mode accept-edits`
- LLM shell tool stays cwd-scoped and blocks pipes, network binaries, sudo, recursive rm, absolute redirects, and interpreter one-liners (still a denylist — use Cursor/Codex/Antigravity for stronger sandboxing)

## Tests

```bash
npm test
```
