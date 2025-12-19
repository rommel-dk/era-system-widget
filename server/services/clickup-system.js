// server/services/clickup-system.js
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const API_TOKEN = process.env.CLICKUP_TOKEN;
const WORKSPACE_ID = process.env.CLICKUP_WORKSPACE_ID || process.env.CLICKUP_TEAM_ID;

const CU_DEBUG = /^(1|true|yes)$/i.test(process.env.CU_DEBUG || "");
const TRACE_PAGES = /^(1|true|yes)$/i.test(process.env.CU_TRACE_PAGES || "");

const DOC_NAME_FILTER = process.env.CU_DOC_NAME_FILTER
    ? new RegExp(process.env.CU_DOC_NAME_FILTER, "i")
    : null;

const SINCE_HOURS = parseInt(process.env.CU_SINCE_HOURS || "0", 10);
const FULL_RESYNC = /^(1|true|yes)$/i.test(process.env.CU_FULL_RESYNC || "");
const cutoffMs =
    (!FULL_RESYNC && SINCE_HOURS > 0)
        ? Date.now() - SINCE_HOURS * 60 * 60 * 1000
        : 0;

const CONCURRENCY = Math.max(1, parseInt(process.env.CU_CONCURRENCY || "6", 10));

if (!API_TOKEN || !WORKSPACE_ID) {
    throw new Error("Missing CLICKUP_TOKEN or CLICKUP_WORKSPACE_ID/CLICKUP_TEAM_ID");
}

async function withBackoff(fn, tries = 5, baseDelay = 600) {
    let delay = baseDelay;
    for (let i = 0; i < tries; i++) {
        try { return await fn(); }
        catch (err) {
            const s = err?.status;
            const retriable = s === 429 || (s >= 500 && s < 600);
            if (retriable && i < tries - 1) {
                await new Promise(r => setTimeout(r, delay));
                delay = Math.min(delay * 2, 8000);
                continue;
            }
            throw err;
        }
    }
    throw new Error("unreachable");
}

async function v3Get(pathname, params = {}) {
    const url = new URL(`https://api.clickup.com/api/v3${pathname}`);
    Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    });

    const res = await fetch(url.toString(), {
        headers: { Authorization: API_TOKEN },
    });

    if (!res.ok) {
        const txt = await res.text().catch(() => "");
        const e = new Error(`ClickUp v3 error ${res.status}: ${txt || "unknown"}`);
        e.status = res.status;
        throw e;
    }
    return res.json();
}

async function mapLimit(items, limit, worker) {
    const results = new Array(items.length);
    let i = 0;
    async function run() {
        while (true) {
            const idx = i++;
            if (idx >= items.length) break;
            try { results[idx] = await worker(items[idx], idx); }
            catch { results[idx] = undefined; }
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
    return results;
}

async function listAllDocs() {
    const docs = [];
    let next_cursor;

    do {
        const data = await withBackoff(() =>
            v3Get(`/workspaces/${WORKSPACE_ID}/docs`, { limit: 100, ...(next_cursor ? { next_cursor } : {}) })
        );

        const batch = data?.docs || [];
        docs.push(...(DOC_NAME_FILTER ? batch.filter(d => d?.name && DOC_NAME_FILTER.test(d.name)) : batch));
        next_cursor = data?.next_cursor;
    } while (next_cursor);

    return docs;
}

async function listPagesMeta(docId) {
    try {
        const data = await withBackoff(() =>
            v3Get(`/workspaces/${WORKSPACE_ID}/docs/${docId}/pages`, { max_page_depth: -1 })
        );
        return Array.isArray(data) ? data : (data?.pages || []);
    } catch (e) {
        if (CU_DEBUG) console.log(`listPagesMeta(${docId}) -> ${e.status || e.message}`);
        return [];
    }
}

async function fetchPageBody(docId, pageId) {
    const fmts = ["text/md", "text/plain", "application/json", "text/html"];
    for (const fmt of fmts) {
        try {
            const data = await withBackoff(() =>
                v3Get(`/workspaces/${WORKSPACE_ID}/docs/${docId}/pages/${pageId}`, { content_format: fmt })
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
            // try next
        }
    }
    return "";
}

/* ---- [system] parsing ---- */

function prepareSystemSource(v = "") {
    let s = String(v);

    // decode a few basic HTML entities (ClickUp sometimes returns these)
    const map = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
    s = s.replace(/&(amp|lt|gt|quot|#39);/g, m => map[m] || m);

    // ClickUp sometimes escapes brackets like \[system]
    s = s.replace(/\\\[/g, "[").replace(/\\\]/g, "]");

    // remove zero-width chars that sometimes break regex matching
    s = s.replace(/[\u200B-\u200D\uFEFF]/g, "");

    return s;
}

function normalizeStatus(s) {
    const v = (s || "").toString().trim().toLowerCase().replace(/[,;]+$/, "");
    if (v === "warn") return "warning";
    if (v === "incident") return "error";
    if (v === "degraded") return "warning";
    if (["ok", "warning", "error"].includes(v)) return v;
    return "ok";
}

function normalizeSolved(s) {
    const v = (s || "").toString().trim().toLowerCase().replace(/[,;]+$/, "");
    if (["yes", "true", "1"].includes(v)) return "yes";
    if (["no", "false", "0"].includes(v)) return "no";
    return "no";
}

function normalizeDisplay(s) {
    const v = (s || "").toString().trim().toLowerCase().replace(/[,;]+$/, "");
    if (["yes", "true", "1", "on"].includes(v)) return "yes";
    if (["no", "false", "0", "off"].includes(v)) return "no";
    return "";
}

function parseDomains(v) {
    // [] = global (everyone)
    if (v == null) return [];
    const raw = String(v).trim();
    if (!raw || raw === "@") return [];
    const parts = raw
        .split(",")
        .map(x => x.trim().toLowerCase())
        .filter(Boolean)
        .map(x => x.startsWith("www.") ? x.slice(4) : x);

    if (parts.includes("@")) return [];
    return Array.from(new Set(parts));
}

function extractAllSystemEntries(body = "") {
    const results = [];
    const plain = prepareSystemSource(body);

    const re = /\[system\]([\s\S]*?)\[\/system\]/gi;
    let m;

    while ((m = re.exec(plain)) !== null) {
        const innerRaw = (m[1] || "");
        const inner = innerRaw.trim();
        if (!inner) continue;

        const obj = {};
        let currentKey = null;

        for (const rawLine of innerRaw.split(/\r?\n/)) {
            const lineTrimmed = rawLine.trim();

            if (!lineTrimmed) {
                if (currentKey === "message") obj.message = (obj.message || "") + "\n";
                continue;
            }

            // allow empty value after ":" (important for "message:" on its own line)
            const kv = lineTrimmed.match(/^([A-Za-z0-9_.-]+)\s*[:=]\s*(.*)$/);
            if (kv) {
                const key = kv[1].toLowerCase();
                let val = (kv[2] || "").trim().replace(/[,;]+$/, "").trim();

                if (key === "message") {
                    // support message: <empty> then continuation lines
                    obj.message = (obj.message || "");
                    if (val) obj.message += val;
                    currentKey = "message";
                } else {
                    obj[key] = val;
                    currentKey = key;
                }
                continue;
            }

            // continuation lines (only for message)
            if (currentKey === "message") {
                obj.message = (obj.message || "");
                if (obj.message && !obj.message.endsWith("\n")) obj.message += "\n";
                obj.message += rawLine;
            }
        }

        const displayNorm = normalizeDisplay(obj.display);

        // Visibility logic (backwards compatible):
        // - If "display" exists -> it controls visibility
        // - Else -> legacy "solved" must be "no"
        if (displayNorm) {
            if (displayNorm !== "yes") continue;
        } else {
            if (normalizeSolved(obj.solved) !== "no") continue;
        }

        results.push({
            name: obj.name || "System message",
            status: normalizeStatus(obj.status),
            display: displayNorm || "yes",
            domains: parseDomains(obj.domain),
            message: obj.message || "",
        });
    }

    return results;
}

export async function harvestSystemMessagesFromDocs() {
    const docs = await listAllDocs();
    if (CU_DEBUG) console.log(`Docs: ${docs.length}`);

    const messages = [];

    for (const doc of docs) {
        const pages = await listPagesMeta(doc.id);

        const recentPages = cutoffMs
            ? pages.filter(p => (Number(p?.date_updated) || 0) >= cutoffMs)
            : pages;

        if (CU_DEBUG) {
            console.log(
                `doc "${doc.name}": pages=${pages.length}, recent=${recentPages.length}` +
                (cutoffMs ? ` since ${new Date(cutoffMs).toISOString()}` : "")
            );
        }

        const bodies = await mapLimit(recentPages, CONCURRENCY, async (p) => {
            const body = await fetchPageBody(doc.id, p.id);
            if (TRACE_PAGES) console.log(` - page "${p.name}" -> ${body ? "ok" : "empty"}`);
            return { page: p, body };
        });

        for (const entry of bodies) {
            if (!entry?.body) continue;

            const found = extractAllSystemEntries(entry.body);
            for (const f of found) {
                messages.push({
                    ...f,
                    doc_id: doc.id,
                    doc_name: doc.name,
                    page_id: entry.page.id,
                    page_name: entry.page.name,
                    updated: entry.page.date_updated
                        ? new Date(Number(entry.page.date_updated)).toISOString()
                        : null,
                });
            }
        }
    }

    const sev = { error: 0, warning: 1, ok: 2 };
    messages.sort((a, b) => {
        const sa = sev[a.status] ?? 9;
        const sb = sev[b.status] ?? 9;
        if (sa !== sb) return sa - sb;
        return (Date.parse(b.updated || "") || 0) - (Date.parse(a.updated || "") || 0);
    });

    const overall =
        messages.some(m => m.status === "error") ? "error" :
            messages.some(m => m.status === "warning") ? "warn" :
                "ok";

    return { overall, messages, updatedAt: new Date().toISOString() };
}

// Optional CLI helper (keeps old module behavior intact)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const outFile = path.join(__dirname, "..", "..", "data", "system.json");

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
    harvestSystemMessagesFromDocs()
        .then((data) => {
            fs.mkdirSync(path.dirname(outFile), { recursive: true });
            fs.writeFileSync(outFile, JSON.stringify(data, null, 2), "utf8");
            console.log(`✅ Wrote ${data.messages.length} message(s) -> ${outFile}`);
        })
        .catch((err) => {
            console.error("❌ Error:", err?.message || err);
            process.exit(1);
        });
}
