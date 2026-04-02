# New Machine Setup

Complete walkthrough for setting up the AI development environment on a new Windows or macOS machine.

## 1. Prerequisites

Install the following tools before proceeding:

### Required Tools

- **Git**: Version control
  - **macOS**: `brew install git` (if not pre-installed)
  - **Windows**: Download from [git-scm.com](https://git-scm.com/)
- **Node.js**: JavaScript runtime for CLI tools
  - **macOS**: `brew install node`
  - **Windows**: Download from [nodejs.org](https://nodejs.org/)
- **Docker**: For Context Lens containers
  - **macOS**: [Docker Desktop for Mac](https://www.docker.com/products/docker-desktop)
  - **Windows**: [Docker Desktop for Windows](https://www.docker.com/products/docker-desktop)

### Optional Tools

- **Bun**: Required for OpenCode local development builds
  - **macOS**: `brew install oven-sh/bun/bun`
  - **Windows**: `powershell -c "irm bun.sh/install.ps1|iex"`
- **yq**: YAML processing for sync script (required for `./setup.sh`)
  - **macOS**: `brew install yq`
  - **Windows**: Download from [GitHub releases](https://github.com/mikefarah/yq/releases)

### SSH Key Setup

Configure SSH for GitHub access (using the `bobthearsonist` identity):

```bash
# Generate SSH key (if you don't have one)
ssh-keygen -t ed25519 -C "your-email@example.com" -f ~/.ssh/id_ed25519

# Add to SSH agent
eval "$(ssh-agent -s)"
ssh-add ~/.ssh/id_ed25519

# Copy public key to clipboard
# macOS:
pbcopy < ~/.ssh/id_ed25519.pub
# Windows (Git Bash):
cat ~/.ssh/id_ed25519.pub | clip
```

Add the public key to your GitHub account: [github.com/settings/keys](https://github.com/settings/keys)

Verify SSH access:
```bash
ssh -T git@github.com
```

---

## 2. Clone the Repositories

Clone both the main AI repo and the infrastructure repo:

```bash
# Main AI repo (instructions, skills, agents, memory)
git clone git@github.com:bobthearsonist/ai.git ~/AI

# Infrastructure repo (MCPs, gateways, platform services)
git clone git@github.com:bobthearsonist/ai-infrastructure.git ~/ai-infrastructure
```

**Note**: On Windows, `~/AI` maps to `C:\Users\<username>\AI`.

---

## 3. Run Setup Script

The setup script configures git hooks for automatic external skill syncing:

```bash
cd ~/AI
./setup.sh
```

**What it does**:
- Enables git hooks (`.githooks/`) for post-checkout and post-merge
- Runs `scripts/sync.sh` to fetch external skills from `external-skills.yaml`
- Syncs local collections from `local.yaml` (if present)

**Note**: External skills will now sync automatically on `git checkout` and `git pull`.

---

## 4. Create Symlinks

Symlinks share the canonical `~/ai/` content with each AI client's expected directories.

### macOS / Linux

```bash
# Claude Code
ln -sf ~/ai/AGENTS.md ~/.claude/CLAUDE.md
ln -sf ~/ai/claude/settings.json ~/.claude/settings.json
ln -sf ~/ai/agents ~/.claude/agents
ln -sf ~/ai/skills ~/.claude/skills

# GitHub Copilot (recommended personal skills path)
mkdir -p ~/.copilot
ln -sf ~/ai/skills ~/.copilot/skills

# OpenCode (Claude-compatible paths work automatically)
```

### Windows (PowerShell)

Run PowerShell **as Administrator** or with **gsudo**:

```powershell
# OpenCode agents (junction, no admin required)
cmd /c mklink /J "$env:USERPROFILE\.config\opencode\agent" "$env:USERPROFILE\ai\agents\opencode"

# Claude Code CLAUDE.md -> AGENTS.md (requires admin OR gsudo)
gsudo New-Item -ItemType SymbolicLink -Path "$env:USERPROFILE\.claude\CLAUDE.md" -Target "$env:USERPROFILE\ai\AGENTS.md"

# Claude Code settings.json
gsudo New-Item -ItemType SymbolicLink -Path "$env:USERPROFILE\.claude\settings.json" -Target "$env:USERPROFILE\ai\claude\settings.json"

# Claude Code agents (junction, no admin required)
cmd /c mklink /J "$env:USERPROFILE\.claude\agents" "$env:USERPROFILE\ai\agents"

# Claude Code skills (symlink to flat skills directory)
gsudo New-Item -ItemType SymbolicLink -Path "$env:USERPROFILE\.claude\skills" -Target "$env:USERPROFILE\ai\skills"

# GitHub Copilot skills (junction, no admin required)
cmd /c mklink /J "$env:USERPROFILE\.copilot\skills" "$env:USERPROFILE\ai\skills"
```

**Note**: OpenCode automatically discovers Claude-compatible skill paths (`~/.claude/skills/`), so no additional symlinks are needed beyond the `~/.config/opencode/agent/` junction.

---

## 5. Configure local.yaml

The `local.yaml` file defines machine-specific collections (work skills, personal skills, etc.). It is **gitignored** so each machine can have its own configuration.

```bash
cd ~/AI
cp local.yaml.example local.yaml
```

Edit `local.yaml` to point to your local repositories:

```yaml
work:
  name: YourCompany
  skills_path: /path/to/yourcompany-ai/skills/
  repositories_root: /path/to/repositories/

paths:
  home: /Users/YourUsername  # or C:\Users\YourUsername on Windows

obsidian:
  vault_path: /path/to/your/obsidian/vault
  personal_daily_folder: 0 Daily Notes
  work_daily_folder: 0 Work/Captains Log

qdrant:
  collections:
    code: Indexed Git repo source code
    # work: Obsidian work notes
    # personal: Obsidian personal notes

collections:
  # Private collection — your personal ai-private repo
  private:
    path: /path/to/your/ai-private
    skills:
      - my-skill
      - another-skill
    agents:
      - my-agent

  # Work collection — your company's repo (uncomment on work machine)
  # work:
  #   path: /path/to/company-ai
  #   skills:
  #     - company-api
  #     - source: dotnet           # dir name in repo
  #       name: company-dotnet     # symlink name in skills/
  #   agents:
  #     - company-agent
```

**What collections do**: The sync script (`scripts/sync.sh`) creates symlinks from your local repos into `~/ai/skills/` and `~/ai/agents/`. This lets you keep work and personal skills in separate repositories while exposing them to all AI clients.

After editing `local.yaml`, run:
```bash
./scripts/sync.sh
```

---

## 6. Shell Integration (init.bash / init.ps1)

The `init.bash` and `init.ps1` files provide shell-level integrations for OpenCode build switching and Context Lens routing.

### Bash / Zsh

Add to `~/.bashrc` or `~/.zshrc`:
```bash
[ -f "$HOME/AI/init.bash" ] && source "$HOME/AI/init.bash"
```

### PowerShell 7

Add to your PowerShell profile (`$PROFILE`):
```powershell
. (Join-Path $HOME AI/init.ps1)
```

To find your profile path:
```powershell
$PROFILE
```

If the file doesn't exist, create it:
```powershell
New-Item -Path $PROFILE -ItemType File -Force
```

### PowerShell 5.1 (Windows PowerShell)

PowerShell 5.1 has a separate profile. Add the same line to its `$PROFILE`:
```powershell
. (Join-Path $HOME AI/init.ps1)
```

### What Shell Integration Provides

| Feature | Command | Description |
|---------|---------|-------------|
| **OpenCode Build Switcher** | `opencode --use list` | List available worktree builds |
| | `opencode --use <name>` | Switch to a specific worktree build (partial name match) |
| | `opencode --use <number>` | Switch to a worktree by number |
| | `opencode --use reset` | Return to npm release build |
| **Context Lens Routing** | (automatic) | Routes OpenCode through mitmproxy if running on `:8080` |

**Why this matters**: The `opencode` shell function automatically:
- Detects if you've selected a local dev build (via `opencode --use`)
- Routes traffic through Context Lens mitmproxy when available (for session capture)
- Falls back to the npm release build if no local build is selected

Reload your shell or source the profile to activate:
```bash
# Bash/Zsh:
source ~/.bashrc  # or ~/.zshrc

# PowerShell:
. $PROFILE
```

---

## 7. Context Lens Setup

Context Lens is a local reverse proxy that intercepts LLM API calls, enabling visualization of context window composition and session capture.

### Install Context Lens CLI

```bash
npm install -g context-lens
```

### Start Docker Containers

Context Lens runs as two Docker containers: mitmproxy (`:8080`) and the web UI (`:4041`).

```bash
docker compose -f ~/ai-infrastructure/platform/context-lens/docker-compose.yml up -d
```

**Verify containers are running**:
```bash
docker ps --filter name=context-lens --filter name=mitmproxy
```

### Trust the mitmproxy CA Certificate

mitmproxy generates a CA certificate at `~/.mitmproxy/mitmproxy-ca-cert.pem`. You must trust it for HTTPS interception to work.

**macOS**:
1. Open Keychain Access
2. Drag `~/.mitmproxy/mitmproxy-ca-cert.pem` into **System** keychain
3. Double-click the certificate → **Trust** → "Always Trust"

**Windows**:
1. Open `certmgr.msc` (Certificate Manager)
2. Right-click **Trusted Root Certification Authorities** → **All Tasks** → **Import**
3. Import `%USERPROFILE%\.mitmproxy\mitmproxy-ca-cert.pem`

**Linux**:
```bash
sudo cp ~/.mitmproxy/mitmproxy-ca-cert.pem /usr/local/share/ca-certificates/mitmproxy.crt
sudo update-ca-certificates
```

### View Captured Sessions

Open the Context Lens web UI:
```
http://localhost:4041
```

For full setup details, see: [docs/context-lens-setup.md](context-lens-setup.md)

---

## 8. MCP Server Configuration

MCP (Model Context Protocol) servers provide tool access to AI clients. Each client stores its MCP configuration in a different location.

See the **ai-client-config** skill for complete per-client paths:
```bash
# From any AI client:
"Load the ai-client-config skill"
```

### Key MCP Servers to Configure

| MCP Server | Purpose | Repository |
|------------|---------|------------|
| **sequential-thinking** | Structured multi-step reasoning | [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking) |
| **memory** | Persistent knowledge graph | [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers/tree/main/src/memory) |
| **context7** | Live documentation lookup | (context7 MCP) |
| **azure-devops** | Work item tracking (if Profisee) | (custom MCP) |

### Example: OpenCode MCP Configuration

Add to `~/.config/opencode/opencode.json`:
```json
{
  "mcpServers": {
    "sequential-thinking": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-sequential-thinking"
      ]
    },
    "memory": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-memory"
      ]
    }
  }
}
```

### Example: Claude Code MCP Configuration

Create `~/.claude/.mcp.json`:
```json
{
  "mcpServers": {
    "sequential-thinking": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-sequential-thinking"
      ]
    },
    "memory": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-memory"
      ]
    }
  }
}
```

Enable the servers in `~/.claude/settings.local.json`:
```json
{
  "enabledMcpjsonServers": [
    "sequential-thinking",
    "memory"
  ]
}
```

---

## 9. VS Code Settings

If using GitHub Copilot in VS Code, configure these settings to enable skills and agents.

Add to your VS Code `settings.json` (User or Workspace):
```json
{
  "chat.useAgentsMdFile": true,
  "chat.useAgentSkills": true,
  "github.copilot.chat.codeGeneration.useInstructionFiles": true,
  "chat.agentSkillsLocations": {
    "~/ai/skills": true
  },
  "chat.agentFilesLocations": {
    "~/ai/agents": true
  },
  "chat.instructionsFilesLocations": {
    "/absolute/path/to/ai/AGENTS.md": true
  }
}
```

**Note**: Replace `/absolute/path/to/ai/AGENTS.md` with the full path to your `AGENTS.md` file (e.g., `C:\\Users\\YourUsername\\AI\\AGENTS.md` on Windows or `/Users/YourUsername/AI/AGENTS.md` on macOS).

**What these do**:
- `chat.useAgentSkills`: Enables Agent Skills discovery
- `chat.agentSkillsLocations`: Direct path to skills without relying on symlinks
- `chat.instructionsFilesLocations`: Loads `AGENTS.md` as instruction context globally

---

## 10. Verification Checklist

After completing setup, verify everything works:

### Skills Discovery

**OpenCode**:
```bash
opencode
# In the chat, type: "List available skills"
```

**Claude Code**:
```bash
claude code
# In the chat, type: "List available skills"
```

Skills should include: `ai-client-config`, `ai-repo-management`, `permissions-yaml`, `skill-promotion`, and any external skills or collections you configured.

### MCP Servers Connected

**OpenCode**: Check the status bar for MCP connection indicators.

**Claude Code**: Check the status bar for MCP connection indicators.

### Context Lens Capturing Sessions

```bash
# Run OpenCode through Context Lens
opencode

# Check web UI for captured sessions
open http://localhost:4041
```

### OpenCode Build Switcher

```bash
opencode --use list
```

Should show:
- Current build (npm release or worktree path)
- Available worktrees (if you have local OpenCode clones)

---

## Troubleshooting

### Skills Not Discovered

**Symptom**: AI client doesn't see skills from `~/ai/skills/`.

**Fix**:
1. Verify symlinks exist and point to the correct location
2. For Copilot, ensure `chat.useAgentSkills: true` in VS Code settings
3. Restart the AI client

### MCP Server Not Connecting

**Symptom**: Tools from MCP server aren't available.

**Fix**:
1. Check the MCP config file path for your client (see ai-client-config skill)
2. Verify the server command is correct (e.g., `npx -y @modelcontextprotocol/server-memory`)
3. Check logs (if available) for connection errors
4. For Claude Code, ensure the server is listed in `enabledMcpjsonServers`

### Context Lens Not Capturing Sessions

**Symptom**: Sessions don't appear in web UI.

**Fix**:
1. Check Docker containers are running: `docker ps`
2. Verify mitmproxy is on port 8080: `curl http://localhost:8080`
3. Ensure CA certificate is trusted by the OS
4. Verify shell integration is active (check if `opencode` is a function: `type opencode`)

### Git Hooks Not Running

**Symptom**: External skills don't sync after `git pull`.

**Fix**:
1. Verify git hooks path: `git config core.hooksPath` (should be `.githooks`)
2. Re-run setup: `./setup.sh`
3. Check hook files are executable: `chmod +x .githooks/*`

---

## Next Steps

- **Create your first skill**: Load the `skill-creator` skill and follow the prompts
- **Add work skills**: Edit `local.yaml` to include your company's skill repo
- **Index repositories**: Set up Qdrant indexer for code search (see `qdrant-indexer` skill)
- **Customize agents**: Create custom agents in `~/ai/agents/` for domain-specific workflows

For more details, see the [main README](../README.md).
