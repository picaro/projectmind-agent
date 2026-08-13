# ProjectMind Agent - Troubleshooting Guide

This guide covers common issues and their solutions. For configuration help, run `projectmind-agent doctor`.

## Table of Contents

- [Installation Issues](#installation-issues)
- [Configuration Problems](#configuration-problems)
- [Runner Issues](#runner-issues)
- [Connection Problems](#connection-problems)
- [Job Execution Failures](#job-execution-failures)
- [Platform-Specific Issues](#platform-specific-issues)

## Installation Issues

### npm: Command not found

**Problem**: `npm install -g projectmind-agent` fails with "command not found"

**Solution**:
1. Install Node.js 22.13 or later from https://nodejs.org
2. Verify installation: `node --version`
3. Try installing again

### Permission denied during npm install

**Problem**: `EACCES` or permission errors during global install

**Solution** (macOS/Linux):
```bash
# Option 1: Use npx instead (no install needed)
npx projectmind-agent

# Option 2: Fix npm permissions
sudo chown -R $USER /usr/local/lib/node_modules
npm install -g projectmind-agent

# Option 3: Use a Node version manager (recommended)
# Install nvm from https://github.com/nvm-sh/nvm
nvm install 22
npm install -g projectmind-agent
```

**Solution** (Windows):
- Run PowerShell or Command Prompt as Administrator
- Then run: `npm install -g projectmind-agent`

## Configuration Problems

### Missing .env file

**Problem**: Agent fails to start with "configuration missing"

**Solution**:
```bash
projectmind-agent setup
```

The wizard will create the `.env` file for you.

### Invalid API key

**Problem**: "Invalid API key", "API keys should start with 'imk_'", or "Configuration missing or incomplete" after browser login

**Solution**:
1. Prefer `projectmind-agent login` (browser pairing). It mints a user-global `imgk_` key by default; project keys use `imk_`, bucket keys use `imbk_`.
2. Make sure you copied the full key (any of those prefixes).
3. Update `.env`:
   ```ini
   IMEMORY_API_KEY=imgk_your_full_api_key_here
   ```
4. Upgrade the agent if an older build only accepted `imk_` and keeps prompting setup after a successful login.

### Workspace allowlist not configured

**Problem**: "IMEMORY_WORKSPACE_ALLOWLIST is not configured"

**Solution**:
Optional when using managed workspaces (`~/.imemory/workspaces`). Otherwise edit `.env` and add absolute paths to directories where the agent can work:

```ini
# Single path
IMEMORY_WORKSPACE_ALLOWLIST=/Users/yourname/projects

# Multiple paths (comma-separated)
IMEMORY_WORKSPACE_ALLOWLIST=/Users/yourname/projects,/Users/yourname/work
```

### Workspace path doesn't exist

**Problem**: "Workspace path does not exist"

**Solution**:
```bash
# Create the directory
mkdir -p /path/to/your/projects

# Or update .env to point to an existing directory
```

## Runner Issues

### No runners available

**Problem**: "No runners are available" or "All runners failed"

**Diagnosis**:
```bash
projectmind-agent runners  # See what's available
projectmind-agent doctor   # Get specific recommendations
```

**Solutions**:

#### Option 1: Use Cursor SDK (easiest)
```bash
# Get API key from Cursor settings
# Add to .env:
CURSOR_API_KEY=your_cursor_api_key
```

#### Option 2: Install Cursor CLI
```bash
# Download from https://cursor.com
# Verify it's on PATH:
which agent  # macOS/Linux
where agent  # Windows
```

#### Option 3: Install Codex CLI
```bash
npm install -g @openai/codex
codex login  # Or set CODEX_API_KEY in .env
```

#### Option 4: Install Claude CLI
```bash
# Download from https://code.claude.com
claude --version  # Verify installation
# Then set ANTHROPIC_API_KEY in .env (optional)
```

### Runner fails health check

**Problem**: Runner shows as available but fails health check

**Diagnosis**:
```bash
projectmind-agent test
```

**Solutions by runner**:

**cursor_sdk fails**:
- Verify `CURSOR_API_KEY` is correct in `.env`
- Check API key hasn't expired

**cursor_cli fails**:
- Run `agent --version` to verify CLI works
- Try `agent login` if authentication is needed

**codex_cli fails**:
- Run `codex --version` to verify CLI works
- Try `codex login` or set `CODEX_API_KEY` in `.env`

**claude_cli fails**:
- Run `claude --version` to verify CLI works
- Try `claude login` or set `ANTHROPIC_API_KEY` in `.env`

### Binary not found on PATH

**Problem**: "runner not available - binary not found on PATH"

**Solution** (macOS/Linux):
```bash
# Find where the binary is installed
which cursor-agent  # or codex, claude, etc.

# If not found, check common locations:
ls -la /usr/local/bin/
ls -la ~/.local/bin/
ls -la ~/bin/

# Add to PATH in ~/.bashrc or ~/.zshrc:
export PATH="$HOME/.local/bin:$PATH"

# Reload shell
source ~/.bashrc  # or ~/.zshrc
```

**Solution** (Windows):
1. Open "Environment Variables" in System Properties
2. Edit the `Path` variable
3. Add the directory containing the binary
4. Restart your terminal

## Connection Problems

### Cannot connect to MCP endpoint

**Problem**: "Cannot connect to MCP endpoint"

**Diagnosis**:
```bash
projectmind-agent doctor
```

**Solutions**:

#### Using production (projectm.dev):
```ini
# In .env:
IMEMORY_MCP_URL=https://projectm.dev/api/mcp
```

Check your internet connection and firewall settings.

#### Using local development:
```ini
# In .env:
IMEMORY_MCP_URL=http://localhost:8080/api/mcp
```

1. Verify ProjectMind app is running locally
2. Check the port (default: 8080)
3. Try accessing http://localhost:8080 in your browser

### Heartbeat failed

**Problem**: "Heartbeat failed" errors in console

**Solutions**:
1. Check network connection
2. Verify MCP URL is correct
3. Check API key is valid
4. Look for firewall blocking outbound connections

### Connection timeout

**Problem**: Operations timeout after 10 seconds

**Solutions**:
1. Check your network speed
2. Try a different network
3. Check for proxy settings that might interfere
4. Verify DNS is working: `nslookup projectm.dev`

## Job Execution Failures

### Job claimed but fails immediately

**Problem**: Agent claims a job but it fails right away

**Diagnosis**:
```bash
# Check agent logs for specific error
# Look for lines starting with "Job failed:"
```

**Common causes**:

1. **Workspace outside allowlist**:
   - Add the workspace path to `IMEMORY_WORKSPACE_ALLOWLIST`

2. **Runner unavailable**:
   - Job specifies a runner that's not configured
   - Run `projectmind-agent runners` to see what's available

3. **Git authentication failed**:
   - For managed workspaces, this is usually automatic
   - For user workspaces, ensure git credentials are configured

### Job succeeds but changes aren't committed

**Problem**: Job completes but git commit/push fails

**Solutions**:

1. **Git not configured**:
   ```bash
   git config --global user.name "Your Name"
   git config --global user.email "you@example.com"
   ```

2. **No git remote**:
   ```bash
   git remote add origin https://github.com/yourname/repo.git
   ```

3. **Authentication failed**:
   - Set up SSH keys or use HTTPS with credentials
   - For GitHub: https://docs.github.com/authentication

4. **Disable git operations** (if not wanted):
   ```ini
   # In .env:
   IMEMORY_AGENT_GIT_COMMIT=0
   ```

### Runner exits with error

**Problem**: Specific runner crashes during execution

**Solutions**:
1. Check runner is up to date: `npm update -g @openai/codex` (for Codex)
2. Try a different runner by specifying in job or changing `IMEMORY_DEFAULT_RUNNER`
3. Check runner-specific logs in the job output

## Platform-Specific Issues

### macOS

#### "Cannot open because it is from an unidentified developer"

**Problem**: Gatekeeper blocks unsigned binary

**Solution**:
```bash
# From the agent directory:
xattr -dr com.apple.quarantine .

# Or double-click clear-quarantine.command (if present)

# If still blocked:
# System Settings → Privacy & Security → Security → "Open Anyway"
```

#### Agent won't start after clearing quarantine

**Problem**: Binary opens but immediately closes

**Solution**:
```bash
# Run from Terminal to see error messages:
cd /path/to/projectmind-agent
./projectmind-agent

# Check for missing dependencies or permissions
```

#### "Operation not permitted" errors

**Problem**: macOS sandbox or permissions block operations

**Solution**:
1. Grant Full Disk Access to Terminal:
   - System Settings → Privacy & Security → Full Disk Access
   - Add Terminal.app
2. Try running from a different directory in your home folder

### Windows

#### "Windows protected your PC" (SmartScreen)

**Problem**: Windows Defender SmartScreen blocks download

**Solution**:
1. Click "More info"
2. Click "Run anyway"

OR:
1. Right-click `projectmind-agent.exe`
2. Properties → General tab
3. Check "Unblock" → Apply → OK

#### PowerShell execution policy error

**Problem**: "cannot be loaded because running scripts is disabled"

**Solution**:
```powershell
# Run PowerShell as Administrator:
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser

# Then try again
```

#### Agent window closes immediately

**Problem**: Console window opens and closes

**Solution**:
```cmd
# Run from Command Prompt to see errors:
cd C:\path\to\projectmind-agent
projectmind-agent.exe

# Look for error messages before it closes
```

#### Path with spaces not working

**Problem**: Workspace path with spaces causes errors

**Solution**:
```ini
# In .env, use forward slashes even on Windows:
IMEMORY_WORKSPACE_ALLOWLIST=C:/Users/Your Name/Projects

# Or use shortened paths:
IMEMORY_WORKSPACE_ALLOWLIST=C:/Users/YOURNA~1/Projects
```

### Linux / Ubuntu

#### libstdc++ not found

**Problem**: "libstdc++.so.6: cannot open shared object file"

**Solution**:
```bash
# Ubuntu/Debian:
sudo apt-get update
sudo apt-get install libstdc++6

# Fedora/RHEL:
sudo dnf install libstdc++
```

#### GLIBC version too old

**Problem**: "version 'GLIBC_2.XX' not found"

**Solution**:
- The binary requires glibc 2.27 or later
- Upgrade your system or use the Node.js version instead:
  ```bash
  npm install -g projectmind-agent
  ```

#### Permission denied

**Problem**: Cannot execute binary

**Solution**:
```bash
chmod +x ./projectmind-agent
./projectmind-agent
```

#### Agent runs but can't access workspace

**Problem**: Permissions on workspace directory

**Solution**:
```bash
# Check permissions:
ls -la /path/to/workspace

# Fix if needed:
sudo chown -R $USER:$USER /path/to/workspace
chmod -R u+rw /path/to/workspace
```

## Getting More Help

If your issue isn't covered here:

1. **Run diagnostics**:
   ```bash
   projectmind-agent doctor
   ```

2. **Check detailed logs**:
   - Agent logs all operations to console
   - Copy relevant error messages

3. **Review configuration**:
   ```bash
   cat .env  # Check your configuration
   projectmind-agent runners  # Check available runners
   ```

4. **Visit documentation**:
   - [Advanced configuration](ADVANCED.md)
   - [ProjectMind documentation](https://projectm.dev/docs)

5. **Report an issue**:
   - GitHub: https://github.com/projectmind/projectmind-agent/issues
   - Include: OS, agent version, error messages, output of `projectmind-agent doctor`

## Quick Diagnostic Commands

```bash
# Full health check
projectmind-agent doctor

# Test all runners
projectmind-agent test

# List available runners
projectmind-agent runners

# Show version
projectmind-agent version

# Reconfigure from scratch
projectmind-agent setup
```
