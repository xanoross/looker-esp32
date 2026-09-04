/**
 * Looker → ESP32 + Excel (Power Automate) Middleware Server
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

// ─── Power Automate flow (Excel-in-SharePoint) ────────────────────────────────
// Set FLOW_WEBHOOK_URL to the URL your Power Automate flow generates.
// Leave it blank and this step is skipped silently.
const FLOW_WEBHOOK_URL = process.env.FLOW_WEBHOOK_URL || null;

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

// Only overwrite a stored balance when the new reading is a real positive number.
// A null / blank / 0 reading is treated as a transient miss, so the previous
// (last-known-good) value is kept instead of flipping the dashboard to $0.
function keepPositive(prev, incoming) {
  return (incoming != null && !isNaN(incoming) && incoming > 0) ? incoming : prev;
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

      // ── Live omnibus balance (keep last good on a blank/0 read) ──────────
      if (f.includes("new_tile_1")) {
        displayData.omnibus_balance = keepPositive(displayData.omnibus_balance, parseNum(rows[0]["Total Balance"]));
      }

      // ── Annual gross revenue (run rate) ──────────────────────────────────
      if (f.includes("new_tile") && !f.includes("new_tile_1")) {
        const col = "(1) Treasury Balances Snapshots Total Balance";
        displayData.gross_revenue_annual = keepPositive(displayData.gross_revenue_annual, parseNum(rows[0][col]));
      }

      // ── Exit balance at 3.4% ─────────────────────────────────────────────
      if (f.includes("copy_3")) {
        displayData.exit_balance = keepPositive(displayData.exit_balance, parseNum(rows[0]["Total at 3.4%"]));
      }

      // ── Annual net revenue (copper rewards) ──────────────────────────────
      if (f.includes("copy_2")) {
        displayData.net_revenue_annual = keepPositive(displayData.net_revenue_annual, parseNum(rows[0]["Total Copper Rewards"]));
      }

      // ── Client balances (only replace when this delivery actually has them) ─
      if (f.includes("live_usdc_balances_by_client")) {
        const list = rows
          .filter(r => r["Organization ID"])
          .slice(0, 8)
          .map(r => ({
            id:      r["Organization ID"],
            balance: parseNum(r["Total Wallet Balance"]),
          }));
        if (list.length) displayData.top_clients = list;
      }

      // ── Recent deposits (only replace when this delivery actually has them) ─
      if (f.includes("usdc_deposits")) {
        const cols = Object.keys(rows[0]);
        console.log("[webhook] deposit columns:", cols);
        const deps = rows.slice(0, 8).map(r => ({
          ts:     r[cols[1]] || "",
          org:    r[cols[2]] || "",
          amount: parseNum(r[cols[4]]),
        }));
        if (deps.length) displayData.recent_deposits = deps;
      }
    });

    displayData.updated_at = new Date().toISOString();
    console.log("[webhook] ✓ updated at", displayData.updated_at,
      "| omnibus:", displayData.omnibus_balance,
      "| clients:", displayData.top_clients.length,
      "| deposits:", displayData.recent_deposits.length);

    // Push to the Excel dashboard via Power Automate — fire-and-forget so it
    // never blocks or breaks the webhook 200 (and the ESP32 feed).
    pushToFlow().catch(e => console.error("[flow] push failed:", e.message));

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[webhook] error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── London time helper (handles BST/GMT automatically) ───────────────────────
function toLondonTime(isoStr) {
  if (!isoStr) return "never";
  const d = new Date(isoStr);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d);
  const get = type => parts.find(p => p.type === type).value;
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

// ─── Build the flat payload the Power Automate flow expects ────────────────────
// One flat object → maps directly onto one row of the Excel "Data" table.
// Numbers are sent raw (not formatted) so Excel holds real numbers and formats them.
function buildFlowPayload(d) {
  // Power Automate's Parse JSON only exposes single-typed fields as mappable
  // tokens, so every numeric field is sent as a plain number (missing → 0),
  // never null. IDs are always strings (missing → "").
  const num = v => (v == null || isNaN(v)) ? 0 : Number(v);
  const payload = {
    id:                   1,                       // fixed key — always the same row
    omnibus_balance:      num(d.omnibus_balance),
    exit_balance:         num(d.exit_balance),
    gross_revenue_annual: num(d.gross_revenue_annual),
    net_revenue_annual:   num(d.net_revenue_annual),
    updated_london:       toLondonTime(d.updated_at),
    updated_iso:          d.updated_at || "",
  };
  const clients = (d.top_clients || []).slice(0, 6);
  for (let i = 0; i < 6; i++) {
    payload[`client${i + 1}_id`]      = clients[i] ? String(clients[i].id) : "";
    payload[`client${i + 1}_balance`] = clients[i] ? num(clients[i].balance) : 0;
  }
  // Recent deposits (top 5). "when" trimmed to "MM-DD HH:MM" like the /display feed.
  const deps = (d.recent_deposits || []).slice(0, 5);
  const shortTs = ts => ts ? String(ts).slice(5, 16).replace("T", " ") : "";
  for (let i = 0; i < 5; i++) {
    payload[`deposit${i + 1}_when`] = deps[i] ? shortTs(deps[i].ts) : "";
    payload[`deposit${i + 1}_org`]  = deps[i] ? String(deps[i].org) : "";
    payload[`deposit${i + 1}_amt`]  = deps[i] ? num(deps[i].amount) : 0;
  }
  return payload;
}

async function pushToFlow() {
  if (!FLOW_WEBHOOK_URL) return;   // not configured — skip silently
  const payload = buildFlowPayload(displayData);
  const r = await fetch(FLOW_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`flow responded HTTP ${r.status}`);
  console.log("[flow] ✓ pushed to Excel dashboard");
}

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
    bal:       fmt(d.omnibus_balance),
    exit:      fmt(d.exit_balance),
    rev_gross: fmt(d.gross_revenue_annual),
    rev_net:   fmt(d.net_revenue_annual),
    clients: d.top_clients.slice(0, 6).map(c => ({
      id:  c.id,
      bal: fmt(c.balance),
    })),
    deposits: d.recent_deposits.slice(0, 8).map(dep => ({   // ← was 5, now 8
      ts:  dep.ts ? String(dep.ts).slice(5, 16).replace("T", " ") : "",
      org: dep.org,
      amt: fmt(dep.amount),
    })),
    updated: toLondonTime(d.updated_at),
  });
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "ok", updated: displayData.updated_at }));

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

module.exports = { app, buildFlowPayload, toLondonTime, displayData };
