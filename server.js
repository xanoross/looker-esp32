/**
 * Looker → ESP32 Middleware Server
 * Handles Looker's "CSV zip file" webhook delivery format
 * Deploy free to: Render.com
 */

const express = require("express");
const AdmZip  = require("adm-zip");
const { parse } = require("csv-parse/sync");

const app = express();

// Accept raw binary bodies (the zip file Looker sends)
app.use(express.raw({ type: "*/*", limit: "50mb" }));

// Also accept JSON for the manual test endpoint
app.use((req, res, next) => {
  if (req.headers["content-type"]?.includes("application/json")) {
    let data = "";
    req.on("data", chunk => { data += chunk; });
    req.on("end", () => {
      try { req.jsonBody = JSON.parse(data); } catch(e) {}
      next();
    });
  } else {
    next();
  }
});

// ─── In-memory store ──────────────────────────────────────────────────────────
let displayData = {
  omnibus_balance:      null,
  exit_balance:         null,
  gross_revenue_annual: null,
  net_revenue_annual:   null,
  ath_balance:          null,
  top_clients:          [],
  recent_deposits:      [],
  updated_at:           null,
};

// ─── Secret tokens (set as Environment Variables on Render) ───────────────────
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || null;
const DISPLAY_SECRET = process.env.DISPLAY_SECRET || null;

function checkWebhookToken(req, res, next) {
  if (!WEBHOOK_SECRET) return next();
  if (req.query.token !== WEBHOOK_SECRET)
    return res.status(401).json({ error: "Unauthorised" });
  next();
}

function checkDisplayToken(req, res, next) {
  if (!DISPLAY_SECRET) return next();
  if (req.query.token !== DISPLAY_SECRET)
    return res.status(401).json({ error: "Unauthorised" });
  next();
}

// ─── POST /webhook/raw  ← Point Looker here FIRST ────────────────────────────
// Click "Test now" in Looker, then check your Render logs.
// You will see the exact filenames and column names inside the zip.
app.post("/webhook/raw", (req, res) => {
  try {
    console.log("[raw] body size (bytes):", req.body?.length);
    const zip = new AdmZip(req.body);
    const entries = zip.getEntries();

    console.log("[raw] files inside zip:");
    entries.forEach(entry => {
      console.log("  FILE:", entry.entryName);
      const text = entry.getData().toString("utf8");
      console.log("  CONTENT (first 500 chars):\n", text.slice(0, 500));
      console.log("  ---");
    });

    res.status(200).json({ ok: true, files: entries.map(e => e.entryName) });
  } catch (err) {
    console.error("[raw] error - maybe not a zip?", err.message);
    console.log("[raw] raw body:", req.body?.toString?.("utf8")?.slice(0, 1000));
    res.status(200).json({ ok: true, note: "check logs" });
  }
});

// ─── POST /webhook  ← The real delivery endpoint ─────────────────────────────
// After checking /webhook/raw logs, update the column name mappings below.
app.post("/webhook", checkWebhookToken, (req, res) => {
  try {
    const zip = new AdmZip(req.body);
    const entries = zip.getEntries();

    entries.forEach(entry => {
      const filename = entry.entryName.toLowerCase();
      const text = entry.getData().toString("utf8");
      let rows;
      try {
        rows = parse(text, { columns: true, skip_empty_lines: true, trim: true });
      } catch(e) {
        console.error("[webhook] CSV parse error in", entry.entryName, e.message);
        return;
      }

      console.log(`[webhook] file: ${entry.entryName} | rows: ${rows.length}`);
      if (rows.length > 0) console.log("[webhook] columns:", Object.keys(rows[0]));

      // ── Update these to match your actual CSV column names ─────────────────
      // You will find the exact names in your Render logs after the /raw test

      if (filename.includes("omnibus") || filename.includes("balance")) {
        const val = rows[0]?.[Object.keys(rows[0])[0]];
        if (val) displayData.omnibus_balance = parseFloat(String(val).replace(/[$,]/g, ""));
      }

      if (filename.includes("client") || filename.includes("org")) {
        displayData.top_clients = rows.slice(0, 8).map(row => {
          const keys = Object.keys(row);
          return {
            id:      row[keys[0]],
            balance: parseFloat(String(row[keys[1]] || "0").replace(/[$,]/g, ""))
          };
        });
      }

      if (filename.includes("deposit") || filename.includes("transaction")) {
        displayData.recent_deposits = rows.slice(0, 8).map(row => {
          const keys = Object.keys(row);
          return {
            ts:     row[keys[0]] || "",
            org:    row[keys[1]] || "",
            amount: parseFloat(String(row[keys[3]] || "0").replace(/[$,]/g, ""))
          };
        });
      }
    });

    displayData.updated_at = new Date().toISOString();
    console.log("[webhook] stored at", displayData.updated_at);
    res.status(200).json({ ok: true });

  } catch (err) {
    console.error("[webhook] error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /display  ← ESP32 polls this every hour ─────────────────────────────
app.get("/display", checkDisplayToken, (req, res) => {
  const d = displayData;

  const fmt = (n) => {
    if (n === null || n === undefined || isNaN(n)) return "---";
    const abs = Math.abs(n);
    const sign = n < 0 ? "-" : "";
    if (abs >= 1e9) return sign + (abs / 1e9).toFixed(2) + "B";
    if (abs >= 1e6) return sign + (abs / 1e6).toFixed(2) + "M";
    if (abs >= 1e3) return sign + (abs / 1e3).toFixed(1) + "K";
    return String(n);
  };

  res.json({
    bal:       fmt(d.omnibus_balance),
    exit:      fmt(d.exit_balance),
    rev_gross: fmt(d.gross_revenue_annual),
    rev_net:   fmt(d.net_revenue_annual),
    ath:       fmt(d.ath_balance),
    clients: d.top_clients.slice(0, 6).map(c => ({
      id:  c.id,
      bal: fmt(c.balance),
    })),
    deposits: d.recent_deposits.slice(0, 5).map(dep => ({
      ts:  dep.ts ? String(dep.ts).slice(5, 16).replace("T", " ") : "",
      org: dep.org,
      amt: fmt(dep.amount),
    })),
    updated: d.updated_at ? d.updated_at.slice(0, 16).replace("T", " ") : "never",
  });
});

// ─── POST /display/manual  ← Test without waiting for Looker ─────────────────
app.post("/display/manual", (req, res) => {
  const body = req.jsonBody || {};
  Object.assign(displayData, body);
  displayData.updated_at = new Date().toISOString();
  res.json({ ok: true });
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "ok", updated: displayData.updated_at }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
