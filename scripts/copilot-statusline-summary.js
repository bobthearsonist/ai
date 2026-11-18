#!/usr/bin/env node

const { execFileSync } = require("node:child_process");
const {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ENTITLEMENT_CACHE_TTL_MS = 5 * 60 * 1000;
const ENTITLEMENT_FAILURE_CACHE_TTL_MS = 60 * 1000;

const COLORS = {
  orange: "\x1b[38;5;208m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
  gray: "\x1b[37m",
  red: "\x1b[31m",
  dim: "\x1b[2m",
  reset: "\x1b[0m",
};

const compactNumberFormatter = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});

function renderStatusLine(status) {
  const cost = objectValue(status.cost);
  const contextWindow = objectValue(status.context_window);
  const workspaceDir = firstString(
    status.workspace?.current_dir,
    status.workspace?.project_dir,
    status.cwd,
    process.cwd()
  );
  const workspace = workspaceDir ? path.basename(workspaceDir) : "";
  const branch = firstString(
    status.git?.branch,
    status.branch,
    tryGitBranch(workspaceDir)
  );

  const model = formatModel(status);
  const contextUsage = formatContextUsage(status, contextWindow);
  const sessionCost = formatSessionCost(cost);
  const sessionUsage = formatSessionUsage(contextWindow);
  const weeklyUsage = formatWeeklyUsage(status, cost);
  const copilotIdentity = formatCopilotIdentity(status);
  const session = firstString(status.session_name, status.session_id);
  const mcpStatus = formatMcpStatus(status);

  const segments = [
    colored(model, "orange"),
    copilotIdentity ? colored(copilotIdentity, "gray") : "",
    mcpStatus,
    colored(`ctx:${contextUsage}`, "cyan"),
    sessionCost ? colored(sessionCost, "green") : "",
    colored(sessionUsage, "yellow"),
    weeklyUsage ? colored(weeklyUsage, "yellow") : "",
    branch ? colored(branch, "magenta") : "",
    workspace ? colored(workspace, "blue") : "",
    session ? colored(session, "dim") : "",
  ].filter(Boolean);

  return segments.join(separator());
}

function run() {
  let input = "";

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => {
    input += chunk;
  });

  process.stdin.on("end", () => {
    if (!input.trim()) {
      return;
    }

    let status;
    try {
      status = JSON.parse(input);
    } catch (error) {
      console.error(`copilot statusline: invalid JSON input: ${error.message}`);
      process.exitCode = 1;
      return;
    }

    process.stdout.write(renderStatusLine(status));
  });
}

function formatModel(status) {
  const model = status.model;
  if (typeof model === "string") {
    return model;
  }

  return firstString(model?.display_name, model?.name, model?.id) || "?";
}

function formatMcpStatus(status) {
  const servers = loadMcpServers(status);
  const failed = namesWithStatus(servers, "failed");
  const needsAuth = namesWithStatus(servers, "needs-auth");
  const pending = namesWithStatus(servers, "pending");

  if (failed.length) {
    return colored(`mcp! ${formatNameList(failed)}`, "red");
  }

  if (needsAuth.length) {
    return colored(`mcp? ${formatNameList(needsAuth)}`, "yellow");
  }

  if (pending.length) {
    return colored(`mcp… ${formatNameList(pending)}`, "dim");
  }

  if (process.env.COPILOT_STATUSLINE_MCP_OK && servers.length) {
    const connected = namesWithStatus(servers, "connected");
    return colored(`mcp:${connected.length}/${servers.length}`, "green");
  }

  return "";
}

function loadMcpServers(status) {
  const fromStdin = normalizeMcpServers(
    status.mcp?.servers || status.mcp_servers
  );
  if (fromStdin.length) {
    return fromStdin;
  }

  const sessionId = firstString(status.session_id);
  if (!sessionId) {
    return [];
  }

  const fromSnapshot = readMcpSnapshot(sessionId);
  if (fromSnapshot.length) {
    return fromSnapshot;
  }

  return readMcpFailuresFromEvents(sessionId);
}

function readMcpSnapshot(sessionId) {
  try {
    const snapshot = JSON.parse(readFileSync(mcpSnapshotPath(sessionId), "utf8"));
    return normalizeMcpServers(snapshot.servers);
  } catch {
    return [];
  }
}

function readMcpFailuresFromEvents(sessionId) {
  const eventsPath = path.join(
    os.homedir(),
    ".copilot",
    "session-state",
    sessionId,
    "events.jsonl"
  );
  if (!existsSync(eventsPath)) {
    return [];
  }

  const byName = new Map();
  for (const line of readHeadAndTail(eventsPath).split(/\r?\n/)) {
    if (!line.includes("mcp")) {
      continue;
    }

    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (event.type === "session.warning" && event.data?.warningType === "mcp") {
      const name = mcpNameFromMessage(event.data.message);
      if (name) {
        byName.set(name, {
          name,
          status: /auth|oauth|unauthorized/i.test(event.data.message || "")
            ? "needs-auth"
            : "failed",
          error: event.data.message || null,
        });
      }
    }

    if (event.type === "session.mcp_server_status_changed" && event.data?.serverName) {
      byName.set(event.data.serverName, {
        name: event.data.serverName,
        status: event.data.status || "failed",
        error: event.data.error || null,
      });
    }

    if (event.type === "session.mcp_servers_loaded" && Array.isArray(event.data?.servers)) {
      for (const server of event.data.servers) {
        if (server?.name) {
          byName.set(server.name, {
            name: server.name,
            status: server.status || "pending",
            error: server.error || null,
          });
        }
      }
    }
  }

  return [...byName.values()];
}

function normalizeMcpServers(value) {
  if (Array.isArray(value)) {
    return value
      .map(server => {
        if (typeof server === "string") {
          return { name: server, status: "failed", error: null };
        }
        if (server && typeof server === "object" && server.name) {
          return {
            name: String(server.name),
            status: String(server.status || "failed"),
            error: server.error || null,
          };
        }
        return null;
      })
      .filter(Boolean);
  }

  if (!value || typeof value !== "object") {
    return [];
  }

  if (Array.isArray(value.servers)) {
    return normalizeMcpServers(value.servers);
  }

  return Object.entries(value)
    .filter(([, status]) => status != null)
    .map(([name, status]) => ({
      name,
      status: typeof status === "string" ? status : status.status || "failed",
      error: status.error || null,
    }));
}

function namesWithStatus(servers, status) {
  return servers
    .filter(server => server.status === status)
    .map(server => server.name);
}

function formatNameList(names, max = 2) {
  if (names.length <= max) {
    return names.join(",");
  }

  return `${names.slice(0, max).join(",")} +${names.length - max}`;
}

function mcpNameFromMessage(message) {
  const match = String(message || "").match(/MCP server "([^"]+)"/i);
  return match ? match[1] : "";
}

function mcpSnapshotPath(sessionId) {
  return path.join(
    os.homedir(),
    ".copilot",
    "session-state",
    sessionId,
    "mcp-status.json"
  );
}

function readHeadAndTail(filePath, windowBytes = 128 * 1024) {
  const stats = statSync(filePath);
  if (stats.size <= windowBytes * 2) {
    return readFileSync(filePath, "utf8");
  }

  const head = Buffer.alloc(windowBytes);
  const tail = Buffer.alloc(windowBytes);
  const fd = openSync(filePath, "r");
  try {
    readSync(fd, head, 0, windowBytes, 0);
    readSync(fd, tail, 0, windowBytes, stats.size - windowBytes);
  } finally {
    closeSync(fd);
  }

  return `${head.toString("utf8")}\n${tail.toString("utf8")}`;
}

function formatContextUsage(status, contextWindow) {
  const percentageValue = firstNumber(
    contextWindow.current_context_used_percentage,
    contextWindow.used_percentage
  );
  const percentage = typeof percentageValue === "number" ? `${Math.round(percentageValue)}%` : "n/a";
  const limit = firstNumber(
    contextWindow.max_context_window_tokens,
    contextWindow.context_window_limit,
    contextWindow.context_window_size,
    contextWindow.displayed_context_limit,
    contextWindow.limit,
    contextWindow.max_tokens,
    status.max_context_window_tokens,
    status.model?.capabilities?.limits?.max_context_window_tokens,
    Number(process.env.COPILOT_STATUSLINE_CONTEXT_LIMIT_TOKENS)
  );
  const current = firstNumber(
    contextWindow.current_context_tokens,
    contextWindow.current_context_window_tokens,
    contextWindow.used_tokens,
    contextWindow.tokens_used,
    contextWindow.total_context_tokens,
    typeof limit === "number" && typeof contextWindow.remaining_tokens === "number"
      ? limit - contextWindow.remaining_tokens
      : undefined,
    typeof limit === "number" && typeof percentageValue === "number"
      ? Math.round((limit * percentageValue) / 100)
      : undefined
  );

  if (typeof current === "number" && typeof limit === "number") {
    return `${percentage} (${formatTokens(current)}/${formatTokens(limit)})`;
  }

  return percentage;
}

function formatSessionCost(cost) {
  const usd = firstNumber(cost.total_cost_usd, cost.cost_usd, cost.cost);
  return typeof usd === "number" ? `$${usd.toFixed(4)}` : "";
}

function formatSessionUsage(contextWindow) {
  const inputTokens = formatTokens(contextWindow.total_input_tokens || 0);
  const outputTokens = formatTokens(contextWindow.total_output_tokens || 0);
  const cachedTokens = firstNumber(contextWindow.total_cache_read_tokens);
  const cached = typeof cachedTokens === "number" ? ` cache:${formatTokens(cachedTokens)}` : "";

  return `tok:↓${inputTokens} ↑${outputTokens}${cached}`;
}

function formatWeeklyUsage(status, cost) {
  const used = firstNumber(
    status.rate_limits?.seven_day?.used_percentage,
    status.usage?.weekly?.used_percentage,
    status.quota?.weekly?.used_percentage,
    status.weekly_usage?.used_percentage,
    cost.weekly_used_percentage
  );

  return typeof used === "number" ? `7d:${Math.round(used)}%` : "";
}

function formatCopilotIdentity(status) {
  const statusLogin = firstString(status.username);
  const entitlement = queryCopilotEntitlement();
  const login = statusLogin || entitlement.login;
  if (!login) {
    return "";
  }

  const billingOrganization = resolveBillingOrganization(
    entitlement.organizations
  );

  return billingOrganization
    ? `${login} bill:@${billingOrganization}`
    : login;
}

function resolveBillingOrganization(organizations) {
  if (!Array.isArray(organizations)) {
    return "";
  }

  return firstString(...organizations);
}

function queryCopilotEntitlement() {
  const cached = readEntitlementCache();
  if (cached) {
    return cached;
  }

  try {
    const response = execFileSync(
      "gh",
      [
        "api",
        "--cache",
        "5m",
        "/copilot_internal/user",
        "--jq",
        '[.login, (.organization_login_list // [] | join(\",\"))] | @tsv',
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 3000,
      }
    ).trim();
    const [login = "", organizationList = ""] = response.split("\t");
    const entitlement = {
      login,
      organizations: organizationList
        .split(",")
        .map(organization => organization.trim())
        .filter(Boolean),
    };
    writeEntitlementCache(entitlement);
    return entitlement;
  } catch {
    const entitlement = { login: "", organizations: [] };
    writeEntitlementCache(entitlement, ENTITLEMENT_FAILURE_CACHE_TTL_MS);
    return entitlement;
  }
}

function entitlementCachePath() {
  return path.join(os.tmpdir(), "copilot-statusline-login.json");
}

function readEntitlementCache() {
  try {
    const cached = JSON.parse(readFileSync(entitlementCachePath(), "utf8"));
    if (
      typeof cached.login === "string" &&
      Array.isArray(cached.organizations) &&
      typeof cached.expiresAt === "number" &&
      cached.expiresAt > Date.now()
    ) {
      return cached;
    }
  } catch {
    // A missing or invalid cache is refreshed from the API.
  }

  return null;
}

function writeEntitlementCache(
  entitlement,
  ttl = ENTITLEMENT_CACHE_TTL_MS
) {
  try {
    writeFileSync(
      entitlementCachePath(),
      JSON.stringify({
        login: entitlement.login || "",
        organizations: entitlement.organizations || [],
        expiresAt: Date.now() + ttl,
      }),
      "utf8"
    );
  } catch {
    // The statusline still works without persistent caching.
  }
}

function tryGitBranch(cwd) {
  if (!cwd) {
    return "";
  }

  try {
    return execFileSync("git", ["branch", "--show-current"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 500,
    }).trim();
  } catch {
    return "";
  }
}

function formatTokens(value) {
  const number = Number(value || 0);
  return compactNumberFormatter.format(Math.round(number)).toLowerCase();
}

function firstNumber(...values) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }

  return undefined;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return "";
}

function objectValue(value) {
  return value && typeof value === "object" ? value : {};
}

function colored(value, color) {
  if (process.env.NO_COLOR) {
    return value;
  }

  return `${COLORS[color]}${value}${COLORS.reset}`;
}

function separator() {
  return ` ${colored("│", "dim")} `;
}

if (require.main === module) {
  run();
}

module.exports = {
  formatCopilotIdentity,
  renderStatusLine,
  resolveBillingOrganization,
};
