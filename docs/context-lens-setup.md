# Context Lens Setup

Context Lens is a local reverse proxy that intercepts LLM API calls via mitmproxy, enabling visualization of context window composition and session capture.

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌──────────────┐
│  AI Client   │────▶│  mitmproxy   │────▶│  LLM API     │
│  (opencode,  │     │  :8080       │     │  (Anthropic,  │
│  claude-code)│     │              │     │   OpenAI)     │
└─────────────┘     └──────┬───────┘     └──────────────┘
                           │
                    ┌──────▼───────┐
                    │ Context Lens │
                    │ Web UI :4041 │
                    └──────────────┘
```

## Prerequisites

- **Docker**: Context Lens runs as Docker containers (mitmproxy + web UI)
- **Node.js**: The `context-lens` CLI is installed via npm
- **mitmproxy CA certificate**: Must be trusted by your OS for HTTPS interception

## Installation

```bash
npm install -g context-lens
```

## Running AI Clients Through Context Lens

There are **two approaches** for routing AI client traffic through Context Lens:

### Approach 1: Environment Variable (Preferred for supporting clients)

Clients that respect `ANTHROPIC_BASE_URL` (like Claude Code) can be configured via environment variable:

```bash
# Set in your shell profile or .env
export ANTHROPIC_BASE_URL=http://localhost:8080
```

This approach is cleaner as it doesn't require wrapper functions and works globally for any process that respects the environment variable.

### Approach 2: Context Lens Wrapper (For clients without base URL support)

For clients that **don't** support `ANTHROPIC_BASE_URL` (like OpenCode), use the `context-lens` wrapper command:

```bash
# Instead of running directly...
# opencode        ← traffic bypasses Context Lens

# ...use the context-lens wrapper:
context-lens opencode    # ← routes through mitmproxy, captured
```

The wrapper:
1. Starts/attaches to the mitmproxy Docker container on port 8080
2. Sets `HTTPS_PROXY=http://localhost:8080` for the child process
3. Launches the AI client with proxy-aware configuration

### Shell Wrappers (for clients without base URL support)

To make the wrapper transparent for OpenCode, create a shell function so you never forget:

**Bash / Zsh:**
```bash
# Add to ~/.bashrc or ~/.zshrc
opencode() { context-lens --no-open opencode "$@"; }
```

**PowerShell:**
```powershell
# Add to $PROFILE
function opencode { context-lens --no-open opencode @args }
```

**Fish:**
```fish
# Add to ~/.config/fish/config.fish
function opencode; context-lens --no-open opencode $argv; end
```

> `--no-open` prevents the browser from auto-opening the web UI on every launch.

## Viewing Captured Sessions

Open the Context Lens web UI:

```
http://localhost:4041
```

## Docker Containers

Context Lens runs two containers:
- **mitmproxy**: Reverse proxy on port 8080
- **context-lens**: Web UI on port 4041

Both are configured with `restart: unless-stopped` so they persist across reboots.

### Container Management

```bash
# Check container status
docker ps --filter name=context-lens --filter name=mitmproxy

# Restart if needed
context-lens start
```

## CA Certificate Trust

mitmproxy generates a CA certificate at `~/.mitmproxy/mitmproxy-ca-cert.pem`. This must be trusted by your OS for HTTPS interception to work.

- **macOS**: Add to Keychain Access → System → Certificates, set to "Always Trust"
- **Windows**: Import into Trusted Root Certification Authorities via `certmgr.msc`
- **Linux**: Copy to `/usr/local/share/ca-certificates/` and run `sudo update-ca-certificates`

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Sessions not captured | Running client directly instead of through wrapper/env var | For OpenCode: use `context-lens opencode` or set up shell wrapper. For Claude Code: set `ANTHROPIC_BASE_URL=http://localhost:8080` |
| SSL/TLS errors | mitmproxy CA cert not trusted | Install CA cert (see above) |
| Docker containers not running | Containers stopped | Run `context-lens start` |
| Port 8080 conflict | Another service on 8080 | Stop conflicting service or reconfigure |
