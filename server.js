/**
 * Looker → ESP32 Middleware Server
 * Handles Looker's JSON webhook where the zip is base64-encoded
 * inside attachment.data
 *
 * Deploy free to: Render.com
 */

const express = require("express");
const AdmZip  = require("adm-zip");
const { parse } = require("csv-parse/sync");

const app = express();

// Looker sends JSON (with the zip base64-encoded inside it)
app.use(express.json({ limit: "50mb" }));

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

// ─── Helper: decode the zip from Looker's JSON payload ───────────────────────
function extractZip(body) {
  const b64 = body?.attachment?.data;
  if (!b64) throw new Error("No attachment.data found in payload");
  const buffer = Buffer.from(b64, "base64");
  return new AdmZip(buffer);
}

// ─── Helper: parse a number from a Looker CSV value like "$795,800,211" ───────
function parseNum(val) {
  if (val === null || val === undefined || val === "") return null;
  const n = parseFloat(String(val).replace(/[$,\s]/g, ""));
  return isNaN(n) ? null : n;
}

// ─── POST /webhook/raw  ← Step 8: point Looker here first to check columns ───
app.post("/webhook/raw", (req, res) => {
  try {
    const zip = extractZip(req.body);
    const entries = zip.getEntries();

    console.log("\n[raw] ── FILES IN ZIP ──────────────────────────────");
    entries.forEach(entry => {
      console.log("\n  FILE:", entry.entryName);
      try {
        const text = entry.getData().toString("utf8");
        console.log("  FIRST 3 ROWS:\n", text.split("\n").slice(0, 3).join("\n"));
      } catch(e) {
        console.log("  (could not read as text)");
      }
      console.log("  ──────────────────────────────────────────────────");
    });

    res.status(200).json({ ok: true, files: entries.map(e => e.entryName) });
  } catch (err) {
    console.error("[raw] error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /webhook  ← The real delivery endpoint ─────────────────────────────
app.post("/webhook", checkWebhookToken, (req, res) => {
  try {
    const zip = extractZip(req.body);
    const entries = zip.getEntries();

    entries.forEach(entry => {
      const filename = entry.entryName.toLowerCase();
      let text, rows;

      try {
        text = entry.getData().toString("utf8");
        rows = parse(text, { columns: true, skip_empty_lines: true, trim: true });
      } catch(e) {
        console.error("[webhook] could not parse", entry.entryName, e.message);
        return;
      }

      if (rows.length === 0) return;
      const cols = Object.keys(rows[0]);
      console.log(`[webhook] ${entry.entryName} → ${rows.length} rows, cols:`, cols);

      // ── live_usdc_balances_by_client.csv ─────────────────────────────────
      if (filename.includes("live_usdc_balances_by_client")) {
        displayData.top_clients = rows.slice(0, 8).map(row => ({
          id:      row[cols[0]],             // first column: org ID e.g. "MOEM"
          balance: parseNum(row[cols[1]])    // second column: balance amount
        }));
        // Also grab the omnibus total (sum of all clients)
        const total = displayData.top_clients.reduce((s, c) => s + (c.balance || 0), 0);
        if (!displayData.omnibus_balance) displayData.omnibus_balance = total;
      }

      // ── usdc_deposits.csv ────────────────────────────────────────────────
      if (filename.includes("usdc_deposits")) {
        displayData.recent_deposits = rows.slice(0, 8).map(row => ({
          ts:     row[cols[0]] || "",        // first column: timestamp
          org:    row[cols[1]] || "",        // second column: org ID
          amount: parseNum(row[cols[3]])     // fourth column: amount (cols[2] is likely direction)
        }));
      }

      // ── annual_run_rate_by_client (copy_2) ───────────────────────────────
      // This tile likely contains gross revenue - grab the total from first row
      if (filename.includes("annual_run_rate") && filename.includes("copy_2")) {
        if (rows[0]) {
          displayData.gross_revenue_annual = parseNum(rows[0][cols[cols.length - 1]]);
        }
      }

      // ── annual_run_rate_by_client (copy_3) ───────────────────────────────
      // This tile likely contains net revenue
      if (filename.includes("annual_run_rate") && filename.includes("copy_3")) {
        if (rows[0]) {
          displayData.net_revenue_annual = parseNum(rows[0][cols[cols.length - 1]]);
        }
      }

      // ── new_tile.csv and new_tile_1.csv ──────────────────────────────────
      // Single-value tiles — log them so we can identify what they contain
      if (filename.includes("new_tile")) {
        console.log("[webhook] new_tile contents:", JSON.stringify(rows.slice(0, 3)));
      }
    });

    displayData.updated_at = new Date().toISOString();
    console.log("[webhook] ✓ stored at", displayData.updated_at);
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
    return n.toFixed(0);
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
app.post("/display/manual", express.json(), (req, res) => {
  Object.assign(displayData, req.body);
  displayData.updated_at = new Date().toISOString();
  res.json({ ok: true });
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "ok", updated: displayData.updated_at }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
