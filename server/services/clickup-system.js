// server/services/clickup-system.js
import axios from "axios";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

/**
 * Harvest [system] blocks from ClickUp Docs (v3) and write to ../data/system.json
 *
 * Block format:
 * [system]
 * name: aws mail server is down
 * status: warning
 * solved: no
 * message: dear era clients...
 * [/system]
 *
 * ENV (required):
 *   CLICKUP_TOKEN
 *   CLICKUP_WORKSPACE_ID (or CLICKUP_TEAM_ID)
 *
 * ENV (optional):
 *   CU_DOC_NAME_FILTER="System|Status|Incidents"  // regex to limit docs by name
 *   CU_DEBUG=0
 *   CU_TRACE_PAGES=0
 *   CU_TRACE_SYSTEM=0
 *   CU_MAX_DOC_DEPTH=0         // recurse into child docs (0 = off)
 *   CU_DUMP_PAGES=0            // dump raw page content under data/dumps/
 *
 *   CU_SINCE_HOURS=60          // ONLY fetch page bodies updated in last N hours
 *   CU_FULL_RESYNC=0           // set to 1 to ignore SINCE window and scan all pages
 *   CU_CONCURRENCY=6           // parallel body fetches
 *
 *   DATA_DIR (optional path for output; defaults to ../../data from this file)
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ALWAYS load env from server/.env
dotenv.config({ path: path.join(__dirname, "..", ".env") });

// NOTE: this file lives in server/services/ → data folder is at repoRoot/data/
const dataDir = process.env.DATA_DIR || path.join(__dirname, "..", "..", "data");
const dumpDir = path.join(dataDir, "dumps");
const outPath = path.join(dataDir, "system.json");

const API_TOKEN = process.env.CLICKUP_TOKEN;
const WORKSPACE_ID = process.env.CLICKUP_WORKSPACE_ID || process.env.CLICKUP_TEAM_ID;

const CU_DEBUG = /^(1|true|yes)$/i.test(process.env.CU_DEBUG || "");
const TRACE_PAGES = /^(1|true|yes)$/i.test(process.env.CU_TRACE_PAGES || "");
const TRACE_SYS = /^(1|true|yes)$/i.test(process.env.CU_TRACE_SYSTEM || "");
const MAX_DEPTH = parseInt(process.env.CU_MAX_DOC_DEPTH || "0", 10);
const DO_DUMP = /^(1|true|yes)$/i.test(process.env.CU_DUMP_PAGES || "");
const DOC_NAME_FILTER = process.env.CU_DOC_NAME_FILTER
    ? new RegExp(process.env.CU_DOC_NAME_FILTER, "i")
    : null;

// Delta knobs
const SINCE_HOURS = parseInt(process.env.CU_SINCE_HOURS || "0", 10);
const FULL_RESYNC = /^(1|true|yes)$/i.test(process.env.CU_FULL_RESYNC || "");
const cutoffMs =
    (!FULL_RESYNC && SINCE_HOURS > 0)
        ? Date.now() - SINCE_HOURS * 60 * 60 * 1000
        : 0;
const CONCURRENCY = Math.max(1, parseInt(process.env.CU_CONCURRENCY || "6", 10));

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
function sanitizeFile(s = "") {
    return String(s).replace(/[^\w.-]+/g, "_").slice(0, 120);
}

function normalizeStatus(s = "") {
    const v = String(s).trim().toLowerCase().replace(/[,;]+$/, "");
    if (v === "warn") return "warning";
    if (v === "incident") return "error";
    if (v === "degraded") return "warning";
    if (["ok", "warning", "error"].includes(v)) return v;
    return "ok";
}

function normalizeSolved(s = "") {
    const v = String(s).trim().toLowerCase().replace(/[,;]+$/, "");
    if (["yes", "true", "1"].includes(v)) return "yes";
    if (["no", "false", "0"].includes(v)) return "no";
    return "no";
}

/**
 * Keep the content mostly raw, but unescape \[ \] so \[system] works.
 * Also decode a few common entities (Docs sometimes returns HTML).
 */
function prepareSystemSource(v = "") {
    let s = String(v);

    const map = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
    s = s.replace(/&(amp|lt|gt|quot|#39);/g, (m) => map[m] || m);

    s = s.replace(/\\\[/g, "[").replace(/\\\]/g, "]");
    return s;
}

/**
 * Extract all [system]...[/system] blocks.
 * - supports multi-line message
 * - solved must be "no" to be included
 */
function extractAllSystemEntries(body = "") {
    const results = [];
    const plain = prepareSystemSource(body);
    const re = /\[system\]([\s\S]*?)\[\/system\]/gi;
    let m;

    while ((m = re.exec(plain)) !== null) {
        const inner = (m[1] || "").trim();
        if (!inner) continue;

        const obj = {};
        let currentKey = null;

        for (const rawLine of inner.split(/\r?\n/)) {
            const line = rawLine.trim();

            // blank line in message keeps newlines
            if (!line) {
                if (currentKey === "message") obj.message = (obj.message || "") + "\n";
                continue;
            }

            // allow [key: value] bracketed lines too
            let l = line;
            if (/^\[.*\]$/.test(l)) l = l.slice(1, -1).trim();

            // key: value OR key=value
            const kv = l.match(/^([A-Za-z0-9_.-]+)\s*[:=]\s*(.+)$/);
            if (kv) {
                const key = kv[1].toLowerCase();
                const val = (kv[2] || "").trim();
                obj[key] = val;
                currentKey = key;
                continue;
            }

            // continuation
            if (currentKey === "message") {
                obj.message = (obj.message || "");
                if (obj.message && !obj.message.endsWith("\n")) obj.message += "\n";
                obj.message += rawLine; // preserve original spacing
            }
        }

        const solved = normalizeSolved(obj.solved);
        if (solved !== "no") continue;

        results.push({
            name: obj.name || "System message",
            status: normalizeStatus(obj.status),
            solved: "no",
            message: obj.message || "",
        });
    }

    // de-dup by (name+status+message) so repeated blocks don’t spam
    const seen = new Set();
    const dedup = [];
    for (const r of results) {
        const k = `${r.name}||${r.status}||${r.message}`;
        if (seen.has(k)) continue;
        seen.add(k);
        dedup.push(r);
    }
    return dedup;
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
        docs.push(...(DOC_NAME_FILTER ? batch.filter((d) => d?.name && DOC_NAME_FILTER.test(d.name)) : batch));
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
    } catch (err) {
        if (CU_DEBUG) {
            console.log(`listChildDocs(${parentDocId}) -> ${err?.response?.status || err?.message}`);
        }
        return [];
    }
}

/** Metadata-only listing with date_updated (no content) */
async function pageListingMeta(docId) {
    try {
        const { data } = await withBackoff(() =>
            v3.get(`/workspaces/${WORKSPACE_ID}/docs/${docId}/pages`, {
                params: { max_page_depth: -1 },
            })
        );
        return Array.isArray(data) ? data : (data?.pages || []);
    } catch (err) {
        if (CU_DEBUG) {
            console.log(`pageListingMeta(${docId}) -> ${err?.response?.status || err?.message}`);
        }
        return [];
    }
}

// fetch page content (try multiple formats until we get text)
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
            // ignore; try next
        }
    }
    return "";
}

// simple concurrency helper
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

async function collectSystemFromDoc(docId, depth = 0) {
    if (depth > MAX_DEPTH) return [];

    // 1) metadata first
    const pages = await pageListingMeta(docId);

    // 2) apply cutoff filter
    const recentPages = cutoffMs
        ? pages.filter((p) => (Number(p?.date_updated) || 0) >= cutoffMs)
        : pages;

    if (CU_DEBUG) {
        console.log(
            `doc ${docId}: pages=${pages.length}, recent=${recentPages.length}` +
            (cutoffMs ? ` since ${new Date(cutoffMs).toISOString()}` : "")
        );
    }
    if (!recentPages.length) return [];

    // 3) fetch bodies for recent pages (concurrently)
    const bodies = await mapLimit(recentPages, CONCURRENCY, (p) => fetchPageBody(docId, p.id));

    const entries = [];
    for (let i = 0; i < recentPages.length; i++) {
        const p = recentPages[i];
        const body = bodies[i];
        if (!body) continue;

        if (DO_DUMP) {
            try {
                fs.mkdirSync(dumpDir, { recursive: true });
                const fname = `${sanitizeFile(docId)}-${sanitizeFile(p.id)}.txt`;
                fs.writeFileSync(path.join(dumpDir, fname), body || "");
            } catch {
                // ignore dump issues
            }
        }

        if (TRACE_PAGES) {
            const prev = (body || "").slice(0, 140).replace(/\s+/g, " ").trim();
            console.log(`   - page ${p.id} "${p.name}" → ${body ? "ok" : "empty"}` + (prev ? " | " + prev : ""));
        }

        const found = extractAllSystemEntries(body);

        for (const e of found) {
            if (TRACE_SYS) {
                console.log(`      • SYSTEM "${p.name}" -> ${e.status}: "${e.name}" msg[${e.message.length}]`);
            }
            entries.push({
                ...e,
                doc_id: docId,
                page_id: p.id,
                page_name: p.name,
                updated: p.date_updated ? new Date(Number(p.date_updated)).toISOString() : null,
            });
        }
    }

    // 4) recurse into child docs if enabled
    if (MAX_DEPTH > depth) {
        const children = await listChildDocs(docId);
        for (const child of children) {
            const more = await collectSystemFromDoc(child.id, depth + 1);
            entries.push(...more);
        }
    }

    return entries;
}

function computeOverall(messages) {
    if (messages.some((m) => m.status === "error")) return "warn" === "error" ? "error" : "error";
    if (messages.some((m) => m.status === "warning")) return "warn";
    return "ok";
}

// ---------- main ----------
export async function updateSystemJsonFromClickUp() {
    console.log(
        "🔎 Scanning Docs for [system] blocks…" +
        (cutoffMs ? ` (delta since ${new Date(cutoffMs).toISOString()})` : " (full scan)")
    );

    const docs = await listAllDocs();
    console.log(
        `📄 Found ${docs.length} doc(s)` + (DOC_NAME_FILTER ? ` (name filter: ${DOC_NAME_FILTER})` : "") + "."
    );

    let all = [];
    let skippedDocs = 0;

    for (const doc of docs) {
        try {
            const entries = await collectSystemFromDoc(doc.id, 0);
            if (!entries.length) {
                skippedDocs++;
                continue;
            }
            // enrich with doc name (nice for debugging)
            all.push(...entries.map((e) => ({ ...e, doc_name: doc.name })));
        } catch (err) {
            skippedDocs++;
            if (CU_DEBUG) {
                console.warn(`⚠️ Error in doc "${doc?.name || doc?.id}": ${err?.message || err}`);
            }
        }
    }

    // Sort: severity (error > warning > ok), then newest updated
    const sev = { error: 0, warning: 1, ok: 2 };
    all.sort((a, b) => {
        const sa = sev[a.status] ?? 9;
        const sb = sev[b.status] ?? 9;
        if (sa !== sb) return sa - sb;
        return (Date.parse(b.updated || "") || 0) - (Date.parse(a.updated || "") || 0);
    });

    // Overall for widget (server expects ok|warn|error; map warning→warn)
    const hasError = all.some((m) => m.status === "error");
    const hasWarn = all.some((m) => m.status === "warning");
    const overall = hasError ? "error" : hasWarn ? "warn" : "ok";

    const payload = {
        overall,
        updatedAt: new Date().toISOString(),
        // keep the fields your widget/API already serves
        messages: all.map(({ name, status, solved, message, doc_name, page_name, updated }) => ({
            name,
            status,
            solved,
            message,
            doc: doc_name || undefined,
            page: page_name || undefined,
            updated: updated || undefined,
        })),
    };

    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), "utf8");

    console.log(
        `\n🧾 Wrote ${payload.messages.length} active system message(s) (docs with no matches: ${skippedDocs}) → ${outPath}`
    );

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
