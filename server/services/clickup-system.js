import axios from "axios";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

/* -------------------------------------------------
   ENV
------------------------------------------------- */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Always load from server/.env
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const DATA_DIR =
    process.env.DATA_DIR || path.join(__dirname, "..", "..", "data");
const OUT_PATH = path.join(DATA_DIR, "system.json");

const API_TOKEN = process.env.CLICKUP_TOKEN;
const WORKSPACE_ID =
    process.env.CLICKUP_WORKSPACE_ID || process.env.CLICKUP_TEAM_ID;

if (!API_TOKEN || !WORKSPACE_ID) {
    console.error(
        "Missing CLICKUP_TOKEN or CLICKUP_WORKSPACE_ID / CLICKUP_TEAM_ID"
    );
    process.exit(1);
}

/* -------------------------------------------------
   CONFIG
------------------------------------------------- */
const DOC_NAME_FILTER = process.env.CU_DOC_NAME_FILTER
    ? new RegExp(process.env.CU_DOC_NAME_FILTER, "i")
    : /System|Status|Incidents/i;

const CONCURRENCY = Math.max(
    1,
    parseInt(process.env.CU_CONCURRENCY || "6", 10)
);

/* -------------------------------------------------
   HTTP
------------------------------------------------- */
const v3 = axios.create({
    baseURL: "https://api.clickup.com/api/v3",
    headers: { Authorization: API_TOKEN },
    timeout: 20000,
});

async function withBackoff(fn, tries = 5) {
    let delay = 500;
    for (let i = 0; i < tries; i++) {
        try {
            return await fn();
        } catch (err) {
            const s = err?.response?.status;
            if ((s === 429 || s >= 500) && i < tries - 1) {
                await new Promise((r) => setTimeout(r, delay));
                delay *= 2;
                continue;
            }
            throw err;
        }
    }
}

/* -------------------------------------------------
   NORMALIZATION HELPERS
------------------------------------------------- */
function normalizeStatus(v = "") {
    const s = String(v).trim().toLowerCase();
    if (["error", "incident", "down"].includes(s)) return "error";
    if (["warning", "warn", "degraded"].includes(s)) return "warning";
    if (["success", "ok", "resolved"].includes(s)) return "ok";
    return "ok";
}

function normalizeDisplay(v = "") {
    const s = String(v).trim().toLowerCase();
    if (["no", "false", "0"].includes(s)) return "no";
    return "yes";
}

/**
 * Normalize a single domain token:
 * - markdown links [text](url)
 * - URLs
 * - remove protocol, path, www
 */
function normalizeHostToken(input = "") {
    let x = String(input || "").trim();

    // markdown [text](url)
    x = x.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => {
        return text || url;
    });

    try {
        if (/^https?:\/\//i.test(x)) {
            x = new URL(x).hostname;
        }
    } catch {}

    x = x.replace(/^https?:\/\//i, "");
    x = x.split("/")[0];
    x = x.toLowerCase();

    if (x.startsWith("www.")) x = x.slice(4);

    return x.trim();
}

function parseDomains(v) {
    if (!v) return [];
    const raw = String(v).trim();
    if (!raw || raw === "@") return [];

    const parts = raw
        .split(",")
        .map(normalizeHostToken)
        .filter(Boolean);

    if (parts.includes("@")) return [];
    return Array.from(new Set(parts));
}

/* -------------------------------------------------
   SYSTEM BLOCK PARSER
------------------------------------------------- */
function extractSystemBlocks(body = "") {
    const results = [];
    const re = /\[system\]([\s\S]*?)\[\/system\]/gi;
    let m;

    while ((m = re.exec(body)) !== null) {
        const block = m[1].trim();
        if (!block) continue;

        const obj = {};
        let current = null;

        for (const rawLine of block.split(/\r?\n/)) {
            const line = rawLine.trim();

            if (!line) {
                if (current === "message")
                    obj.message = (obj.message || "") + "\n";
                continue;
            }

            const kv = line.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
            if (kv) {
                const key = kv[1].toLowerCase();
                const val = kv[2] ?? "";

                if (key === "message") {
                    obj.message = val;
                    current = "message";
                } else {
                    obj[key] = val;
                    current = key;
                }
                continue;
            }

            if (current === "message") {
                obj.message =
                    (obj.message || "") +
                    (obj.message?.endsWith("\n") ? "" : "\n") +
                    rawLine;
            }
        }

        if (normalizeDisplay(obj.display) !== "yes") continue;

        results.push({
            name: obj.name || "System message",
            status: normalizeStatus(obj.status),
            display: "yes",
            domains: parseDomains(obj.domain),
            message: (obj.message || "").trim(),
        });
    }

    return results;
}

/* -------------------------------------------------
   CLICKUP FETCH
------------------------------------------------- */
async function listDocs() {
    const docs = [];
    let cursor;

    do {
        const { data } = await withBackoff(() =>
            v3.get(`/workspaces/${WORKSPACE_ID}/docs`, {
                params: { limit: 100, ...(cursor ? { next_cursor: cursor } : {}) },
            })
        );

        const batch = data?.docs || [];
        docs.push(...batch.filter((d) => DOC_NAME_FILTER.test(d.name)));
        cursor = data?.next_cursor;
    } while (cursor);

    return docs;
}

async function fetchPages(docId) {
    const { data } = await withBackoff(() =>
        v3.get(`/workspaces/${WORKSPACE_ID}/docs/${docId}/pages`, {
            params: { max_page_depth: -1 },
        })
    );
    return Array.isArray(data) ? data : data?.pages || [];
}

async function fetchPageBody(docId, pageId) {
    const fmts = ["text/md", "text/plain", "text/html", "application/json"];
    for (const fmt of fmts) {
        try {
            const { data } = await withBackoff(() =>
                v3.get(
                    `/workspaces/${WORKSPACE_ID}/docs/${docId}/pages/${pageId}`,
                    { params: { content_format: fmt } }
                )
            );
            const c = data?.content;
            if (!c) continue;

            if (fmt === "application/json") {
                return JSON.stringify(c);
            }
            return String(c);
        } catch {}
    }
    return "";
}

/* -------------------------------------------------
   MAIN
------------------------------------------------- */
export async function updateSystemJsonFromClickUp() {
    console.log("🔎 Scanning ClickUp for [system] blocks…");

    const docs = await listDocs();
    const messages = [];

    for (const doc of docs) {
        const pages = await fetchPages(doc.id);

        for (const p of pages) {
            const body = await fetchPageBody(doc.id, p.id);
            if (!body) continue;

            const found = extractSystemBlocks(body);
            found.forEach((m) =>
                messages.push({
                    ...m,
                    doc: doc.name,
                    page: p.name,
                    updated: p.date_updated
                        ? new Date(Number(p.date_updated)).toISOString()
                        : null,
                })
            );
        }
    }

    const visible = messages.filter((m) => m.display === "yes");

    const overall = visible.some((m) => m.status === "error")
        ? "error"
        : visible.some((m) => m.status === "warning")
            ? "warn"
            : "ok";

    const payload = {
        overall,
        updatedAt: new Date().toISOString(),
        messages: visible,
    };

    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2), "utf8");

    console.log(`🧾 Wrote ${visible.length} system message(s)`);
}

/* -------------------------------------------------
   CLI
------------------------------------------------- */
if (import.meta.url === `file://${process.argv[1]}`) {
    updateSystemJsonFromClickUp()
        .then(() => process.exit(0))
        .catch((err) => {
            console.error("❌ Error:", err?.message || err);
            process.exit(1);
        });
}
