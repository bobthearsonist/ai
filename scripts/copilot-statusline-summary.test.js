const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  resolveBillingOrganization,
} = require("./copilot-statusline-summary.js");

const scriptPath = path.join(__dirname, "copilot-statusline-summary.js");

test("resolves the sole enterprise candidate for an enterprise entitlement", () => {
  const plans = new Map([
    ["Profisee", "free"],
    ["Epyon-Ltd", "enterprise"],
  ]);

  assert.equal(
    resolveBillingOrganization(
      "enterprise",
      ["Profisee", "Epyon-Ltd"],
      organization => plans.get(organization)
    ),
    "Epyon-Ltd"
  );
});

test("resolves the sole non-enterprise candidate for a business entitlement", () => {
  const plans = new Map([
    ["Profisee", "free"],
    ["Epyon-Ltd", "enterprise"],
  ]);

  assert.equal(
    resolveBillingOrganization(
      "business",
      ["Profisee", "Epyon-Ltd"],
      organization => plans.get(organization)
    ),
    "Profisee"
  );
});

test("fails closed when multiple candidates match the active tier", () => {
  assert.equal(
    resolveBillingOrganization(
      "enterprise",
      ["First-Enterprise", "Second-Enterprise"],
      () => "enterprise"
    ),
    ""
  );
});

test("renders the dynamically resolved billed organization", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "copilot-statusline-test-"));
  const binDir = path.join(root, "bin");
  const cacheDir = path.join(root, "cache");
  const ghPath = path.join(binDir, process.platform === "win32" ? "gh.cmd" : "gh");

  try {
    mkdirSync(binDir);
    mkdirSync(cacheDir);
    writeFileSync(
      path.join(cacheDir, "copilot-statusline-login.json"),
      JSON.stringify({
        login: "stale-account",
        expiresAt: Date.now() - 1,
      }),
      "utf8"
    );

    if (process.platform === "win32") {
      writeFileSync(
        ghPath,
        [
          "@echo off",
          "echo %* | findstr /C:\"copilot_internal/user\" >nul && (",
          "  echo bobthearsonist	enterprise	Profisee,Epyon-Ltd",
          "  exit /b 0",
          ")",
          "echo %* | findstr /C:\"orgs/Profisee\" >nul && (echo free& exit /b 0)",
          "echo enterprise",
        ].join("\r\n"),
        "utf8"
      );
    } else {
      writeFileSync(
        ghPath,
        [
          "#!/bin/sh",
          "case \"$*\" in",
          "  *copilot_internal/user*) printf '%s\\t%s\\t%s\\n' bobthearsonist enterprise Profisee,Epyon-Ltd ;;",
          "  *orgs/Profisee*) printf '%s\\n' free ;;",
          "  *orgs/Epyon-Ltd*) printf '%s\\n' enterprise ;;",
          "  *) exit 91 ;;",
          "esac",
          "",
        ].join("\n"),
        "utf8"
      );
      chmodSync(ghPath, 0o755);
    }

    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        NO_COLOR: "1",
        PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
        TMPDIR: cacheDir,
        TEMP: cacheDir,
        TMP: cacheDir,
      },
      input: JSON.stringify({
        model: "test-model",
        context_window: {},
        workspace: {
          current_dir: root,
        },
      }),
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /bobthearsonist bill:@Epyon-Ltd/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
