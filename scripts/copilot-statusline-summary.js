#!/usr/bin/env node

const { execFileSync } = require("node:child_process");
const path = require("node:path");

const COLORS = {
  orange: "\x1b[38;5;208m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
  gray: "\x1b[37m",
  dim: "\x1b[2m",
  reset: "\x1b[0m",
};

const compactNumberFormatter = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});

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
  const account = formatAccount(status);
  const session = firstString(status.session_name, status.session_id);

  const segments = [
    colored(model, "orange"),
    colored(`ctx:${contextUsage}`, "cyan"),
    sessionCost ? colored(sessionCost, "green") : "",
    colored(sessionUsage, "yellow"),
    weeklyUsage ? colored(weeklyUsage, "yellow") : "",
    branch ? colored(branch, "magenta") : "",
    workspace ? colored(workspace, "blue") : "",
    account ? colored(account, "gray") : "",
    session ? colored(session, "dim") : "",
  ].filter(Boolean);

  process.stdout.write(segments.join(separator()));
});

function formatModel(status) {
  const model = status.model;
  if (typeof model === "string") {
    return model;
  }

  return firstString(model?.display_name, model?.name, model?.id) || "?";
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

function formatAccount(status) {
  const email = firstString(
    status.account?.email,
    status.user?.email,
    status.github?.email,
    status.githubUser?.email
  );
  if (email && email.includes("@")) {
    return `@${email.split("@")[1].split(".")[0]}`;
  }

  const login = firstString(
    status.account?.login,
    status.user?.login,
    status.github?.login,
    status.githubUser?.login,
    status.username
  );

  return login ? `@${login}` : "";
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
