import "dotenv/config";
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// --------------------------------------------------
// Paths
// --------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dataPath = path.join(__dirname, "..", "data", "system.json");
const widgetPath = path.join(__dirname, "..", "widget");

// --------------------------------------------------
// App setup
// --------------------------------------------------
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --------------------------------------------------
// Serve widget statically
// --------------------------------------------------
app.use("/widget", express.static(widgetPath));

// Optional: redirect root → widget for local dev
app.get("/", (req, res) => {
  res.redirect("/widget/index.html");
});

// --------------------------------------------------
// Health check
// --------------------------------------------------
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// --------------------------------------------------
// Status API – READ ONLY from data/system.json
// --------------------------------------------------
app.get("/api/status", (req, res) => {
  try {
    const raw = fs.readFileSync(dataPath, "utf8");
    res.type("json").send(raw);
  } catch (err) {
    // Fail safe: never break widget
    res.json({
      overall: "ok",
      updatedAt: new Date().toISOString(),
      messages: [],
    });
  }
});

// --------------------------------------------------
// Contact form → Postmark
// --------------------------------------------------
app.post("/api/widget-contact", async (req, res) => {
  try {
    const { client_id = "", name = "", email = "", message = "" } = req.body || {};

    // Honeypot (bots fill it, humans don't)
    if (req.body?.company) {
      return res.json({ ok: true });
    }

    const r = await fetch("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Postmark-Server-Token": process.env.POSTMARK_SERVER_TOKEN,
      },
      body: JSON.stringify({
        From: process.env.POSTMARK_FROM,
        To: process.env.POSTMARK_TO,
        Subject: `Widget contact (${client_id || "unknown"})`,
        TextBody:
            `Client ID: ${client_id}\n` +
            `Name: ${name}\n` +
            `Email: ${email}\n\n` +
            `${message}`,
      }),
    });

    if (!r.ok) {
      const t = await r.text().catch(() => "");
      throw new Error(`Postmark error ${r.status}: ${t || "unknown"}`);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("❌ widget-contact failed:", err.message || err);
    res.status(500).json({ ok: false });
  }
});

// --------------------------------------------------
// Start server
// --------------------------------------------------
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`era-system-widget server listening on :${port}`);
});
