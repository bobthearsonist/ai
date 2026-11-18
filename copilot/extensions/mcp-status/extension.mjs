// Extension: mcp-status
// Writes live MCP server status for the Copilot statusline

import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { joinSession } from "@github/copilot-sdk/extension";

const REFRESH_INTERVAL_MS = 5000;

let session;
let refreshTimer;
let refreshPromise;
let shuttingDown = false;

function snapshotPath(sessionId) {
    return path.join(
        os.homedir(),
        ".copilot",
        "session-state",
        sessionId,
        "mcp-status.json"
    );
}

function collectServers(list) {
    const byName = new Map();
    const host = list?.host && typeof list.host === "object" ? list.host : {};

    for (const server of Array.isArray(list?.servers) ? list.servers : []) {
        if (!server?.name) {
            continue;
        }

        byName.set(server.name, {
            name: server.name,
            status: server.status || "pending",
            error: server.error || null,
        });
    }

    for (const [name, info] of Object.entries(host.failedServers || {})) {
        const current = byName.get(name) || { name, status: "failed", error: null };
        if (current.status !== "connected") {
            current.status = "failed";
        }
        current.error = current.error || info?.message || null;
        byName.set(name, current);
    }

    for (const [name, info] of Object.entries(host.needsAuthServers || {})) {
        if (!byName.has(name)) {
            byName.set(name, {
                name,
                status: "needs-auth",
                error: info?.message || null,
            });
        }
    }

    for (const name of host.pendingConnections || []) {
        if (!byName.has(name)) {
            byName.set(name, { name, status: "pending", error: null });
        }
    }

    return [...byName.values()].sort((left, right) =>
        left.name.localeCompare(right.name)
    );
}

function writeSnapshot(payload) {
    const dest = snapshotPath(session.sessionId);
    mkdirSync(path.dirname(dest), { recursive: true });
    const json = `${JSON.stringify(payload, null, 2)}\n`;
    const tmp = `${dest}.${process.pid}.tmp`;
    writeFileSync(tmp, json, "utf8");
    try {
        renameSync(tmp, dest);
    } catch {
        writeFileSync(dest, json, "utf8");
        try {
            unlinkSync(tmp);
        } catch {
            // Temp file cleanup is best-effort on Windows.
        }
    }
}

async function refresh() {
    if (shuttingDown || refreshPromise) {
        return refreshPromise;
    }

    refreshPromise = (async () => {
        try {
            const list = await session.rpc.mcp.list();
            writeSnapshot({
                updatedAt: new Date().toISOString(),
                sessionId: session.sessionId,
                servers: collectServers(list),
            });
        } catch {
            // Keep the last good snapshot; the statusline can fall back to events.jsonl.
        }
    })().finally(() => {
        refreshPromise = undefined;
    });

    return refreshPromise;
}

session = await joinSession({});

session.on("session.mcp_servers_loaded", () => {
    void refresh();
});
session.on("session.mcp_server_status_changed", () => {
    void refresh();
});
session.on("session.warning", event => {
    if (event.data?.warningType === "mcp") {
        void refresh();
    }
});
session.on("session.shutdown", () => {
    shuttingDown = true;
    if (refreshTimer) {
        clearInterval(refreshTimer);
    }
});

refreshTimer = setInterval(() => {
    void refresh();
}, REFRESH_INTERVAL_MS);
refreshTimer.unref?.();

await refresh();
