# ProjectMind Agent

> **Desktop agent that connects your local machine to ProjectMind and executes AI coding tasks using your preferred AI assistant.**

[![Version](https://img.shields.io/badge/version-0.2.4-blue.svg)](https://github.com/projectmind/projectmind-agent)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Ubuntu-lightgrey.svg)]()

## Quick Start

### Install via npm

```bash
npm install -g projectmind-agent
projectmind-agent setup
```

### Or run with npx

```bash
npx projectmind-agent setup
```

The setup wizard will guide you through configuration in under 2 minutes.

## What It Does

The ProjectMind Agent runs on your machine and:

- **Connects** to ProjectMind via secure heartbeat
- **Claims** coding tasks queued from the web interface
- **Executes** tasks using AI assistants (Cursor, Claude, Codex, etc.)
- **Auto-updates** when new versions are released

All work happens in directories you explicitly allow, with full control over what the agent can access.

> **Note:** This repo is a worker / reference implementation for ProjectMind — it claims and executes jobs but does not own product direction. The canonical product vision, agent/orchestration protocol, and control-plane docs (`docs/product-vision.md`, protocol/MCP docs, etc.) live in the ProjectMind (imemory) control-plane repo; consult those before making architectural changes here.

## Commands

Once installed, you can use these commands:

```bash
projectmind-agent          # Start the agent (begins polling for jobs)
projectmind-agent setup    # Run interactive configuration wizard
projectmind-agent doctor   # Check configuration and diagnose issues
projectmind-agent test     # Test all configured AI assistants
projectmind-agent runners  # List available AI assistant integrations
projectmind-agent help     # Show help information
```

## Product direction

This agent is a worker in the ProjectMind protocol — it claims and executes jobs but never owns lifecycle state, retries, budgets, or approvals; the ProjectMind orchestrator (`imemory` repo) does. For the control-plane vision and where this agent fits (reference Node.js agent, protocol/SDK direction, profiles), see [`docs/product-vision.md`](https://github.com/picaro/iremenber/blob/main/docs/product-vision.md) and [`docs/product-vision-gap-analysis.md`](https://github.com/picaro/iremenber/blob/main/docs/product-vision-gap-analysis.md) in the main ProjectMind repository.

## Requirements

- **API Key**: Get from [ProjectMind → Project → Settings → API Keys](https://projectm.dev)
- **Workspace Path**: A directory where the agent can execute tasks
- **AI Assistant**: At least one of:
  - Cursor SDK (set `CURSOR_API_KEY`)
  - Cursor CLI (`agent` on PATH)
  - Codex CLI (`codex` on PATH)
  - Claude CLI (`claude` on PATH)
  - Anthropic API key
  - Or any other [supported runner](ADVANCED.md)

Don't worry if you're unsure — the setup wizard will detect what's available and guide you.

## Troubleshooting

If you encounter issues:

1. Run `projectmind-agent doctor` to diagnose problems
2. Check [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for common issues
3. Visit the [Advanced Documentation](ADVANCED.md) for detailed configuration

### Common Issues

**macOS: "Cannot open because it is from an unidentified developer"**
```bash
xattr -dr com.apple.quarantine /path/to/projectmind-agent
```

**Windows: "Windows protected your PC"**
- Click "More info" → "Run anyway"

**No runners available**
```bash
# Install Cursor CLI or set API key
npm install -g @cursor/sdk
export CURSOR_API_KEY=your_key_here
```

Run `projectmind-agent doctor` for personalized diagnostics.

## Platform Downloads

Pre-built binaries (no Node.js required):

- **macOS**: [Apple Silicon](https://projectm.dev/downloads/agent/projectmind-agent-macos-arm64.zip) | [Intel](https://projectm.dev/downloads/agent/projectmind-agent-macos-x64.zip)
- **Windows**: [x64](https://projectm.dev/downloads/agent/projectmind-agent-windows-x64.zip)
- **Ubuntu/Linux**: [x64](https://projectm.dev/downloads/agent/projectmind-agent-ubuntu-x64.zip)
- **Node.js**: [Cross-platform](https://projectm.dev/downloads/agent/projectmind-agent-nodejs.zip)

Each download includes a platform-specific README with setup instructions.

## Configuration

The agent uses a `.env` file for configuration. The setup wizard creates this for you, but you can also configure manually:

```ini
# Required
IMEMORY_API_KEY=imk_your_api_key_here
IMEMORY_WORKSPACE_ALLOWLIST=/path/to/your/projects

# Optional
IMEMORY_MCP_URL=https://projectm.dev/api/mcp
CURSOR_API_KEY=your_cursor_key  # For Cursor SDK runner
```

For advanced configuration options, see [ADVANCED.md](ADVANCED.md).

## Safety & Security

- ✅ Only explicitly queued jobs are executed
- ✅ Works only in allowlisted directories
- ✅ API keys stay local (never transmitted)
- ✅ All network calls go to ProjectMind MCP endpoint
- ✅ Workspace paths validated with symlink protection
- ✅ Git operations use short-lived tokens

See [ADVANCED.md](ADVANCED.md) for detailed security information.

## Links

- **Documentation**: [ADVANCED.md](ADVANCED.md) | [TROUBLESHOOTING.md](TROUBLESHOOTING.md)
- **Website**: https://projectm.dev
- **Support**: https://projectm.dev/docs
- **GitHub**: https://github.com/projectmind/projectmind-agent

## License

See [LICENSE](LICENSE) file for details.
