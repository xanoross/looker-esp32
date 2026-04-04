/**
 * Looker → ESP32 Middleware Server
 * Final version with confirmed column mappings
 * Deploy free to: Render.com
 */
 
const express = require("express");
const AdmZip  = require("adm-zip");
const { parse } = require("csv-parse/sync");
 
const app = express();
app.use(express.json({ limit: "50mb" }));
 
// ─── In-memory store ──────────────────────────────────────────────────────────
let displayData = {
  omnibus_balance:      null,   // new_tile_1.csv         → Total Balance
  gross_revenue_annual: null,   // new_tile.csv           → (1) Treasury Balances Snapshots Total Balance
  exit_balance:         null,   // copy_3.csv             → Total at 3.4%
  net_revenue_annual:   null,   // copy_2.csv             → Total Copper Rewards
  top_clients:          [],     // live_usdc_balances     → Organization ID + Total Wallet Balance
  recent_deposits:      [],     // usdc_deposits.csv      → cols by position
  updated_at:           null,
};
 
// ─── Tokens ───────────────────────────────────────────────────────────────────
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
 
// ─── Helpers ──────────────────────────────────────────────────────────────────
function extractZip(body) {
  const b64 = body?.attachment?.data;
  if (!b64) throw new Error("No attachment.data in payload");
  return new AdmZip(Buffer.from(b64, "base64"));
}
 
function parseNum(val) {
  if (val == null || val === "") return null;
  const n = parseFloat(String(val).replace(/[$,\s]/g, ""));
  return isNaN(n) ? null : n;
}
 
function parseRows(entry) {
  const text = entry.getData().toString("utf8");
  return parse(text, { columns: true, skip_empty_lines: true, trim: true });
}
 
// ─── POST /webhook  ← Looker delivers here ───────────────────────────────────
app.post("/webhook", checkWebhookToken, (req, res) => {
  try {
    const zip = extractZip(req.body);
 
    zip.getEntries().forEach(entry => {
      const f = entry.entryName.toLowerCase();
      let rows;
      try { rows = parseRows(entry); } catch(e) { return; }
      if (!rows.length) return;
 
      // ── Live omnibus balance ─────────────────────────────────────────────
      // File: new_tile_1.csv  |  Column: "Total Balance"  |  e.g. 795,170,211
      if (f.includes("new_tile_1")) {
        displayData.omnibus_balance = parseNum(rows[0]["Total Balance"]);
      }
 
      // ── Annual gross revenue (run rate) ──────────────────────────────────
      // File: new_tile.csv  |  Column: "(1) Treasury Balances Snapshots Total Balance"
      // First row is the most recent snapshot = current run rate
      if (f.includes("new_tile") && !f.includes("new_tile_1")) {
        const col = "(1) Treasury Balances Snapshots Total Balance";
        displayData.gross_revenue_annual = parseNum(rows[0][col]);
      }
 
      // ── Exit balance at 3.4% ─────────────────────────────────────────────
      // File: annual_run_rate_by_client_(copy_3).csv  |  Column: "Total at 3.4%"
      // All rows show the same grand total — just take row 0
      if (f.includes("copy_3")) {
        displayData.exit_balance = parseNum(rows[0]["Total at 3.4%"]);
      }
 
      // ── Annual net revenue (copper rewards) ──────────────────────────────
      // File: annual_run_rate_by_client_(copy_2).csv  |  Column: "Total Copper Rewards"
      if (f.includes("copy_2")) {
        displayData.net_revenue_annual = parseNum(rows[0]["Total Copper Rewards"]);
      }
 
      // ── Client balances ──────────────────────────────────────────────────
      // File: live_usdc_balances_by_client.csv
      // Columns: "Organization ID", "Total Wallet Balance"
      if (f.includes("live_usdc_balances_by_client")) {
        displayData.top_clients = rows
          .filter(r => r["Organization ID"])
          .slice(0, 8)
          .map(r => ({
            id:      r["Organization ID"],
            balance: parseNum(r["Total Wallet Balance"]),
          }));
      }
 
      // ── Recent deposits ──────────────────────────────────────────────────
      // File: usdc_deposits.csv
      // Columns by position: [0]=row num, [1]=timestamp, [2]=org ID,
      //                       [3]=direction (1/-1), [4]=amount
      if (f.includes("usdc_deposits")) {
        const cols = Object.keys(rows[0]);
        console.log("[webhook] deposit columns:", cols);
        displayData.recent_deposits = rows.slice(0, 8).map(r => ({
          ts:     r[cols[1]] || "",
          org:    r[cols[2]] || "",
          amount: parseNum(r[cols[4]]),
        }));
      }
    });
 
    displayData.updated_at = new Date().toISOString();
    console.log("[webhook] ✓ updated at", displayData.updated_at,
      "| omnibus:", displayData.omnibus_balance,
      "| clients:", displayData.top_clients.length,
      "| deposits:", displayData.recent_deposits.length);
 
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[webhook] error:", err.message);
    res.status(500).json({ error: err.message });
  }
});
 
// ─── GET /display  ← ESP32 polls this every hour ─────────────────────────────
app.get("/display", checkDisplayToken, (req, res) => {
  const fmt = (n) => {
    if (n == null || isNaN(n)) return "---";
    const abs = Math.abs(n);
    const s = n < 0 ? "-" : "";
    if (abs >= 1e9) return s + (abs / 1e9).toFixed(2) + "B";
    if (abs >= 1e6) return s + (abs / 1e6).toFixed(2) + "M";
    if (abs >= 1e3) return s + (abs / 1e3).toFixed(1) + "K";
    return n.toFixed(0);
  };
 
  const d = displayData;
  res.json({
    bal:       fmt(d.omnibus_balance),        // e.g. "795.17M"
    exit:      fmt(d.exit_balance),           // e.g. "26.64M"
    rev_gross: fmt(d.gross_revenue_annual),   // e.g. "806.58M"
    rev_net:   fmt(d.net_revenue_annual),     // e.g. "1.89M"
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
 
// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "ok", updated: displayData.updated_at }));
 
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
