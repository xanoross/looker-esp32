/**
 * Looker → ESP32 + Slack Middleware Server
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

// ─── Slack config ───────────────────────────────────────────────────────────────
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || null;   // xoxb-… (Render env var)
const SLACK_CHANNEL   = process.env.SLACK_CHANNEL   || null;   // channel ID, e.g. C0123ABCD
const SLACK_TITLE     = process.env.SLACK_TITLE     || "USDC Balances — Live";
let   slackMessageTs  = null;                                  // remembered so we edit one message

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

// Shared money formatter (used by /display and Slack)
function fmtMoney(n) {
  if (n == null || isNaN(n)) return "---";
  const abs = Math.abs(n);
  const s = n < 0 ? "-" : "";
  if (abs >= 1e9) return s + "$" + (abs / 1e9).toFixed(2) + "B";
  if (abs >= 1e6) return s + "$" + (abs / 1e6).toFixed(2) + "M";
  if (abs >= 1e3) return s + "$" + (abs / 1e3).toFixed(1) + "K";
  return s + "$" + Math.abs(n).toFixed(0);
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
      if (f.includes("new_tile_1")) {
        displayData.omnibus_balance = parseNum(rows[0]["Total Balance"]);
      }

      // ── Annual gross revenue (run rate) ──────────────────────────────────
      if (f.includes("new_tile") && !f.includes("new_tile_1")) {
        const col = "(1) Treasury Balances Snapshots Total Balance";
        displayData.gross_revenue_annual = parseNum(rows[0][col]);
      }

      // ── Exit balance at 3.4% ─────────────────────────────────────────────
      if (f.includes("copy_3")) {
        displayData.exit_balance = parseNum(rows[0]["Total at 3.4%"]);
      }

      // ── Annual net revenue (copper rewards) ──────────────────────────────
      if (f.includes("copy_2")) {
        displayData.net_revenue_annual = parseNum(rows[0]["Total Copper Rewards"]);
      }

      // ── Client balances ──────────────────────────────────────────────────
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

    // Push to Slack — fire-and-forget so it never blocks/breaks the webhook 200.
    pushToSlack().catch(e => console.error("[slack] push failed:", e.message));

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

// ─── Slack: build the message ─────────────────────────────────────────────────
function buildSlackBlocks(d) {
  const blocks = [
    { type: "header", text: { type: "plain_text", text: SLACK_TITLE, emoji: true } },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Omnibus balance*\n${fmtMoney(d.omnibus_balance)}` },
        { type: "mrkdwn", text: `*Exit balance (3.4%)*\n${fmtMoney(d.exit_balance)}` },
        { type: "mrkdwn", text: `*Gross revenue (annual)*\n${fmtMoney(d.gross_revenue_annual)}` },
        { type: "mrkdwn", text: `*Net revenue (annual)*\n${fmtMoney(d.net_revenue_annual)}` },
      ],
    },
  ];

  if (d.top_clients && d.top_clients.length) {
    const lines = d.top_clients
      .slice(0, 6)
      .map((c, i) => `${i + 1}. \`${c.id}\` — ${fmtMoney(c.balance)}`)
      .join("\n");
    blocks.push({ type: "divider" });
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `*Top clients*\n${lines}` } });
  }

  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: `Updated ${toLondonTime(d.updated_at)} London · refreshes every 15 min` }],
  });

  return blocks;
}

// ─── Slack: post once, then edit the same message every cycle ─────────────────
async function slackCall(method, payload) {
  const r = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Authorization": `Bearer ${SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify(payload),
  });
  const json = await r.json();
  if (!json.ok) throw new Error(`${method}: ${json.error}`);
  return json;
}

async function pushToSlack() {
  if (!SLACK_BOT_TOKEN || !SLACK_CHANNEL) return;   // Slack not configured — skip silently

  const blocks = buildSlackBlocks(displayData);
  const text   = `USDC omnibus balance ${fmtMoney(displayData.omnibus_balance)} (updated ${toLondonTime(displayData.updated_at)})`;

  // Edit the existing message if we have one; otherwise post a fresh one.
  if (slackMessageTs) {
    try {
      await slackCall("chat.update", { channel: SLACK_CHANNEL, ts: slackMessageTs, text, blocks });
      return;
    } catch (e) {
      // Server restarted / message deleted → fall through and post a new message.
      if (!/message_not_found|cant_update_message/.test(e.message)) throw e;
      slackMessageTs = null;
    }
  }

  const res = await slackCall("chat.postMessage", { channel: SLACK_CHANNEL, text, blocks });
  slackMessageTs = res.ts;
  console.log("[slack] posted new message ts", slackMessageTs);
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

module.exports = { app, buildSlackBlocks, fmtMoney, toLondonTime, displayData };
