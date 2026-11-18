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

test("uses the first organization returned by the Copilot entitlement", () => {
  assert.equal(
    resolveBillingOrganization(["Profisee", "Epyon-Ltd"]),
    "Profisee"
  );
});

test("ignores empty organization values", () => {
  assert.equal(resolveBillingOrganization(["", "Profisee"]), "Profisee");
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
          "  echo bobthearsonist	Profisee,Epyon-Ltd",
          "  exit /b 0",
          ")",
          "exit /b 91",
        ].join("\r\n"),
        "utf8"
      );
    } else {
      writeFileSync(
        ghPath,
        [
          "#!/bin/sh",
          "case \"$*\" in",
          "  *copilot_internal/user*) printf '%s\\t%s\\n' bobthearsonist Profisee,Epyon-Ltd ;;",
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
    assert.match(result.stdout, /bobthearsonist bill:@Profisee/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
