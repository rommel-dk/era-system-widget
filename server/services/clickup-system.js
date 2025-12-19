import axios from "axios";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

/**
 * Harvest [system] blocks from ClickUp Docs (v3) and write to ../../data/system.json
 *
 * Block format:
 * [system]
 * name: Something
 * status: warning|error|ok|success
 * display: yes|no
 * domain: conscia.com, example.org, @
 * message:
 * Multiline text...
 * [/system]
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Always load env from server/.env (so scripts work when run from repo root)
dotenv.config({ path: path.join(__dirname, "..", ".env") });

// Paths (this file is server/services/, data folder is repoRoot/data/)
const dataDir = process.env.DATA_DIR || path.join(__dirname, "..", "..", "data");
const outPath = path.join(dataDir, "system.json");

const API_TOKEN = process.env.CLICKUP_TOKEN;
const WORKSPACE_ID = process.env.CLICKUP_WORKSPACE_ID || process.env.CLICKUP_TEAM_ID;

const CU_DEBUG = /^(1|true|yes)$/i.test(process.env.CU_DEBUG || "");
const MAX_DEPTH = parseInt(process.env.CU_MAX_DOC_DEPTH || "0", 10);
const DOC_NAME_FILTER = process.env.CU_DOC_NAME_FILTER
    ? new RegExp(process.env.CU_DOC_NAME_FILTER, "i")
    : null;

const CONCURRENCY = Math.max(1, parseInt(process.env.CU_CONCURRENCY || "6", 10));

// Delta knobs (optional)
const SINCE_HOURS = parseInt(process.env.CU_SINCE_HOURS || "0", 10);
const FULL_RESYNC = /^(1|true|yes)$/i.test(process.env.CU_FULL_RESYNC || "");
const cutoffMs =
    !FULL_RESYNC && SINCE_HOURS > 0 ? Date.now() - SINCE_HOURS * 60 * 60 * 1000 : 0;

if (!API_TOKEN || !WORKSPACE_ID) {
    console.error("Missing CLICKUP_TOKEN or CLICKUP_WORKSPACE_ID/CLICKUP_TEAM_ID.");
    process.exit(1);
}

// ---------- HTTP ----------
const v3 = axios.create({
    baseURL: "https://api.clickup.com/api/v3",
    headers: { Authorization: API_TOKEN },
    timeout: 20000,
});

async function withBackoff(fn, tries = 5, baseDelay = 600) {
    let delay = baseDelay;
    for (let i = 0; i < tries; i++) {
        try {
            return await fn();
        } catch (err) {
            const s = err?.response?.status;
            const retriable = s === 429 || (s >= 500 && s < 600);
            if (retriable && i < tries - 1) {
                await new Promise((r) => setTimeout(r, delay));
                delay = Math.min(delay * 2, 8000);
                continue;
            }
            throw err;
        }
    }
    throw new Error("unreachable");
}

// ---------- helpers ----------
function normalizeStatus(s = "") {
    const v = String(s).trim().toLowerCase().replace(/[,;]+$/, "");
    if (v === "warn") return "warning";
    if (v === "incident") return "error";
    if (v === "degraded") return "warning";
    if (v === "success") return "ok";
    if (["ok", "warning", "error"].includes(v)) return v;
    return "ok";
}

function normalizeDisplay(s = "") {
    const v = String(s).trim().toLowerCase().replace(/[,;]+$/, "");
    if (["no", "false", "0", "off"].includes(v)) return "no";
    return "yes"; // default visible
}

/**
 * ClickUp often returns escaped brackets or HTML entities.
 * This makes regex detection reliable again.
 */
function prepareSource(v = "") {
    let s = String(v);

    // decode a few basic entities
    const map = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
    s = s.replace(/&(amp|lt|gt|quot|#39);/g, (m) => map[m] || m);

    // unescape \[ \] so \[system] becomes [system]
    s = s.replace(/\\\[/g, "[").replace(/\\\]/g, "]");

    return s;
}

/**
 * Normalize ONE domain token:
 * - markdown link [text](url) -> text OR URL host
 * - URL -> hostname
 * - remove protocol/path/www
 */
function normalizeHostToken(input = "") {
    let x = String(input || "").trim();

    // markdown link: [text](url)
    x = x.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, text, url) => {
        const t = String(text || "").trim();
        if (t) return t;
        return String(url || "").trim();
    });

    // if it’s a URL, extract hostname
    try {
        if (/^https?:\/\//i.test(x)) x = new URL(x).hostname;
    } catch {
        // ignore parse errors
    }

    // strip protocol if present
    x = x.replace(/^https?:\/\//i, "");

    // strip path/query/hash
    x = x.split("/")[0].split("?")[0].split("#")[0];

    x = x.toLowerCase().trim();
    if (x.startsWith("www.")) x = x.slice(4);

    return x;
}

function parseDomains(v) {
    // [] = global
    if (v == null) return [];
    const raw = String(v).trim();
    if (!raw) return [];
    if (raw === "@") return [];

    const parts = raw
        .split(",")
        .map((x) => normalizeHostToken(x))
        .filter(Boolean);

    if (parts.includes("@")) return [];
    return Array.from(new Set(parts));
}

/**
 * Extract all [system]...[/system] blocks.
 * Supports:
 * - key: value OR key=value
 * - multiline message starting with "message:" (possibly empty after :)
 */
function extractAllSystemEntries(body = "") {
    const results = [];
    const plain = prepareSource(body);

    const re = /\[system\]([\s\S]*?)\[\/system\]/gi;
    let m;

    while ((m = re.exec(plain)) !== null) {
        const inner = (m[1] || "").trim();
        if (!inner) continue;

        const obj = {};
        let currentKey = null;

        for (const rawLine of inner.split(/\r?\n/)) {
            const lineTrim = rawLine.trim();

            // preserve blank lines in message
            if (!lineTrim) {
                if (currentKey === "message") obj.message = (obj.message || "") + "\n";
                continue;
            }

            // allow bracketed lines: [key: value]
            let l = lineTrim;
            if (/^\[.*\]$/.test(l)) l = l.slice(1, -1).trim();

            // key: value OR key=value (value may be empty!)
            const kv = l.match(/^([A-Za-z0-9_.-]+)\s*[:=]\s*(.*)$/);
            if (kv) {
                const key = kv[1].toLowerCase();
                const valRaw = (kv[2] ?? "").toString();

                if (key === "message") {
                    obj.message = (obj.message || "") + valRaw; // keep as-is (can be empty)
                    currentKey = "message";
                } else {
                    obj[key] = valRaw.trim();
                    currentKey = key;
                }
                continue;
            }

            // continuation lines
            if (currentKey === "message") {
                obj.message = obj.message || "";
                if (obj.message && !obj.message.endsWith("\n")) obj.message += "\n";
                obj.message += rawLine; // preserve original spacing
            }
        }

        const display = normalizeDisplay(obj.display);
        if (display !== "yes") continue;

        const name = (obj.name || "").trim();
        if (!name) continue;

        results.push({
            name,
            status: normalizeStatus(obj.status),
            display: "yes",
            domains: parseDomains(obj.domain),
            message: (obj.message || "").trim(),
        });
    }

    return results;
}

// ---------- API helpers ----------
async function listAllDocs() {
    const docs = [];
    let next_cursor;
    do {
        const { data } = await withBackoff(() =>
            v3.get(`/workspaces/${WORKSPACE_ID}/docs`, {
                params: { limit: 100, ...(next_cursor ? { next_cursor } : {}) },
            })
        );
        const batch = data?.docs || [];
        docs.push(
            ...(DOC_NAME_FILTER
                ? batch.filter((d) => d?.name && DOC_NAME_FILTER.test(d.name))
                : batch)
        );
        next_cursor = data?.next_cursor;
    } while (next_cursor);
    return docs;
}

async function listChildDocs(parentDocId) {
    try {
        const { data } = await withBackoff(() =>
            v3.get(`/workspaces/${WORKSPACE_ID}/docs`, {
                params: { parent_type: "DOC", parent_id: parentDocId, limit: 100 },
            })
        );
        return data?.docs || [];
    } catch {
        return [];
    }
}

async function pageListingMeta(docId) {
    try {
        const { data } = await withBackoff(() =>
            v3.get(`/workspaces/${WORKSPACE_ID}/docs/${docId}/pages`, {
                params: { max_page_depth: -1 },
            })
        );
        return Array.isArray(data) ? data : data?.pages || [];
    } catch {
        return [];
    }
}

// fetch page content (try multiple formats until we get useful text)
async function fetchPageBody(docId, pageId) {
    const fmts = ["text/md", "text/plain", "application/json", "text/html"];

    for (const fmt of fmts) {
        try {
            const { data } = await withBackoff(() =>
                v3.get(`/workspaces/${WORKSPACE_ID}/docs/${docId}/pages/${pageId}`, {
                    params: { content_format: fmt },
                })
            );

            const c = data?.content;
            if (!c) continue;

            // JSON format often contains the real text distributed across nodes
            if (fmt === "application/json") {
                const root = typeof c === "string" ? JSON.parse(c) : c;

                const stack = [root];
                const out = [];
                while (stack.length) {
                    const cur = stack.pop();
                    if (typeof cur === "string") out.push(cur);
                    else if (Array.isArray(cur)) stack.push(...cur);
                    else if (cur && typeof cur === "object") stack.push(...Object.values(cur));
                }
                const t = out.join("\n").trim();
                if (t) return t;
                continue;
            }

            const t = String(c).trim();
            if (t) return t;
        } catch {
            // try next format
        }
    }

    return "";
}

// concurrency helper
async function mapLimit(items, limit, worker) {
    const results = new Array(items.length);
    let i = 0;
    async function run() {
        while (true) {
            const idx = i++;
            if (idx >= items.length) break;
            try {
                results[idx] = await worker(items[idx], idx);
            } catch {
                results[idx] = undefined;
            }
        }
    }
    const n = Math.min(limit, items.length);
    await Promise.all(Array.from({ length: n }, run));
    return results;
}

async function collectSystemFromDoc(doc, depth = 0) {
    if (depth > MAX_DEPTH) return [];

    const pages = await pageListingMeta(doc.id);
    const recentPages = cutoffMs
        ? pages.filter((p) => (Number(p?.date_updated) || 0) >= cutoffMs)
        : pages;

    if (CU_DEBUG) {
        console.log(
            `doc "${doc.name}" (${doc.id}): pages=${pages.length}, recent=${recentPages.length}` +
            (cutoffMs ? ` since ${new Date(cutoffMs).toISOString()}` : "")
        );
    }

    if (!recentPages.length) return [];

    const bodies = await mapLimit(recentPages, CONCURRENCY, (p) =>
        fetchPageBody(doc.id, p.id)
    );

    const entries = [];
    for (let i = 0; i < recentPages.length; i++) {
        const p = recentPages[i];
        const body = bodies[i];
        if (!body) continue;

        const found = extractAllSystemEntries(body);
        for (const e of found) {
            entries.push({
                ...e,
                doc: doc.name,
                page: p.name,
                updated: p.date_updated ? new Date(Number(p.date_updated)).toISOString() : null,
            });
        }
    }

    if (MAX_DEPTH > depth) {
        const children = await listChildDocs(doc.id);
        for (const child of children) {
            const more = await collectSystemFromDoc(child, depth + 1);
            entries.push(...more);
        }
    }

    return entries;
}

// ---------- main ----------
export async function updateSystemJsonFromClickUp() {
    console.log(
        "🔎 Scanning Docs for [system] blocks…" +
        (cutoffMs ? ` (delta since ${new Date(cutoffMs).toISOString()})` : " (full scan)")
    );

    const docs = await listAllDocs();
    console.log(
        `📄 Found ${docs.length} doc(s)` +
        (DOC_NAME_FILTER ? ` (name filter: ${DOC_NAME_FILTER})` : "") +
        "."
    );

    let all = [];
    let docsWithNoMatches = 0;

    for (const doc of docs) {
        const entries = await collectSystemFromDoc(doc, 0);
        if (!entries.length) docsWithNoMatches++;
        all.push(...entries);
    }

    // visible entries
    const visible = all.filter((m) => m.display === "yes");

    // Sort: error > warning > ok; then newest updated
    const sev = { error: 0, warning: 1, ok: 2 };
    visible.sort((a, b) => {
        const sa = sev[a.status] ?? 9;
        const sb = sev[b.status] ?? 9;
        if (sa !== sb) return sa - sb;
        return (Date.parse(b.updated || "") || 0) - (Date.parse(a.updated || "") || 0);
    });

    // Widget expects ok|warn|error
    const hasError = visible.some((m) => m.status === "error");
    const hasWarn = visible.some((m) => m.status === "warning");
    const overall = hasError ? "error" : hasWarn ? "warn" : "ok";

    const payload = {
        overall,
        updatedAt: new Date().toISOString(), // fetch time
        messages: visible.map((m) => ({
            name: m.name,
            status: m.status,
            display: m.display,
            domains: Array.isArray(m.domains) ? m.domains : [],
            message: m.message,
            doc: m.doc,
            page: m.page,
            updated: m.updated,
        })),
    };

    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), "utf8");

    console.log(
        `\n🧾 Wrote ${payload.messages.length} visible system message(s)` +
        ` (docs with no matches: ${docsWithNoMatches}) → ${outPath}`
    );

    // Helpful debug if empty:
    if (payload.messages.length === 0) {
        console.log("⚠️ No visible messages. Most common causes:");
        console.log("   - display: no");
        console.log("   - blocks are escaped like \\[system] (this script unescapes that)");
        console.log("   - page content returned as JSON (this script flattens it)");
    }

    return payload;
}

// CLI
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
    updateSystemJsonFromClickUp()
        .then(() => process.exit(0))
        .catch((err) => {
            console.error("❌ Error:", err?.response?.data || err?.message || err);
            process.exit(1);
        });
}
