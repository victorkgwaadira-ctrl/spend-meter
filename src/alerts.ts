import type { Env } from "./env";
import { getSettings, logEvent } from "./db";
import { monthSummary } from "./summary";

export type Channel = "email" | "telegram" | "whatsapp" | "slack" | "teams";

export function configuredChannels(env: Env): Record<Channel, boolean> {
  return {
    email: !!(env.RESEND_API_KEY && env.ALERT_EMAIL_TO),
    telegram: !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
    whatsapp: !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_WHATSAPP_FROM && env.WHATSAPP_TO),
    slack: !!env.SLACK_WEBHOOK_URL,
    teams: !!env.TEAMS_WEBHOOK_URL,
  };
}

/** Pull the bot token out of whatever was saved: tolerates a pasted URL, a "bot" prefix, quotes, spaces or hidden characters. */
export function telegramToken(raw?: string): string | null {
  const m = (raw ?? "").match(/(\d{5,}:[A-Za-z0-9_-]{30,})/);
  return m ? m[1] : null;
}
export function telegramChat(raw?: string): string | null {
  const s = (raw ?? "").trim();
  const m = s.match(/-?\d{5,}/) ?? s.match(/@[A-Za-z0-9_]{4,}/);
  return m ? m[0] : null;
}
const mask = (t: string) => t.slice(0, 6) + "…" + t.slice(-4);
function describe(raw?: string): string {
  const s = raw ?? "";
  const odd = [...s].filter((c) => !/[A-Za-z0-9:_\-]/.test(c)).length;
  return `${s.length} characters${odd ? `, ${odd} unexpected` : ""}`;
}

async function post(url: string, init: RequestInit): Promise<void> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${new URL(url).host} returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

const senders: Record<Channel, (env: Env, title: string, body: string) => Promise<void>> = {
  email: (env, title, body) =>
    post("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: env.ALERT_EMAIL_FROM || "API Spend Meter <onboarding@resend.dev>",
        to: env.ALERT_EMAIL_TO!.split(",").map((s) => s.trim()),
        subject: title,
        text: body,
      }),
    }),
  telegram: async (env, title, body) => {
    const token = telegramToken(env.TELEGRAM_BOT_TOKEN);
    const chat = telegramChat(env.TELEGRAM_CHAT_ID);
    if (!token) throw new Error(`TELEGRAM_BOT_TOKEN doesn't look like a bot token (${describe(env.TELEGRAM_BOT_TOKEN)}). It should look like 8900000000:AAxxxx…`);
    if (!chat) throw new Error(`TELEGRAM_CHAT_ID doesn't look like a chat id (${describe(env.TELEGRAM_CHAT_ID)}). It should be a number like 612345678`);
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: `${title}\n\n${body}`, disable_web_page_preview: true }),
    });
    if (res.ok) return;
    const j: any = await res.json().catch(() => ({}));
    const hint =
      res.status === 401 || res.status === 404
        ? `Telegram doesn't recognise the bot token (saved as ${mask(token)}). Copy the latest token from BotFather.`
        : res.status === 400 && /chat not found/i.test(j.description ?? "")
          ? `Chat ${chat} not found. Send your bot a message first, and check the id from getUpdates.`
          : res.status === 403
            ? `The bot can't message chat ${chat}. Open the bot in Telegram and tap Start.`
            : `Telegram returned ${res.status}: ${j.description ?? ""}`;
    throw new Error(hint);
  },
  whatsapp: (env, title, body) =>
    post(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: "Basic " + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ From: env.TWILIO_WHATSAPP_FROM!, To: env.WHATSAPP_TO!, Body: `*${title}*\n${body}` }),
    }),
  slack: (env, title, body) =>
    post(env.SLACK_WEBHOOK_URL!, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: `*${title}*\n${body}` }),
    }),
  // Teams "Workflows" incoming webhook (Post to a channel when a webhook request is received)
  teams: (env, title, body) =>
    post(env.TEAMS_WEBHOOK_URL!, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "message",
        attachments: [
          {
            contentType: "application/vnd.microsoft.card.adaptive",
            content: {
              $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
              type: "AdaptiveCard",
              version: "1.4",
              body: [
                { type: "TextBlock", text: title, weight: "Bolder", size: "Medium", wrap: true },
                { type: "TextBlock", text: body, wrap: true },
              ],
            },
          },
        ],
      }),
    }),
};

/** Send to every configured channel. One failing channel never blocks the others. */
/** Send through one channel and throw on failure (used to test a connection before saving it). */
export async function sendOne(env: Env, ch: Channel, title: string, body: string): Promise<void> {
  await senders[ch](env, title, body);
}

export async function notify(env: Env, title: string, body: string): Promise<Record<string, string>> {
  const on = configuredChannels(env);
  const out: Record<string, string> = {};
  await Promise.all(
    (Object.keys(senders) as Channel[]).map(async (ch) => {
      if (!on[ch]) {
        out[ch] = "not set up";
        return;
      }
      try {
        await senders[ch](env, title, body);
        out[ch] = "sent";
      } catch (e) {
        out[ch] = "failed: " + (e as Error).message.replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot<token>");
      }
    }),
  );
  const failed = Object.entries(out).filter(([, v]) => v.startsWith("failed"));
  if (failed.length) await logEvent(env, "alerts", "delivery_error", failed.map(([k, v]) => `${k} ${v}`).join("; "), out);
  return out;
}

const usd = (n: number) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Fire each budget level (e.g. 50/80/100%) once per month when month-to-date spend reaches it. */
export async function checkThresholds(env: Env): Promise<void> {
  const settings = await getSettings(env);
  if (!(settings.budget > 0)) return;
  const month = new Date().toISOString().slice(0, 7);
  const sum = await monthSummary(env, month, settings);
  const pct = (sum.total / settings.budget) * 100;
  const levels = [...settings.levels].filter((l) => l > 0).sort((a, b) => a - b);
  const crossed = levels.filter((l) => pct >= l);
  if (!crossed.length) return;
  const level = crossed[crossed.length - 1];

  // Claim every crossed level; only alert if the highest one is new (skips a burst of 50+80+100 at once).
  let isNew = false;
  for (const l of crossed) {
    const r = await env.DB.prepare("INSERT OR IGNORE INTO alerts(month, scope, level, sent_at, detail) VALUES(?, 'total', ?, ?, ?)")
      .bind(month, l, Date.now(), `${pct.toFixed(1)}%`)
      .run();
    if (l === level && r.meta.changes > 0) isNew = true;
  }
  if (!isNew) return;

  const top = sum.byProvider.slice(0, 3).map((p) => `${p.name} ${usd(p.amount)}`).join(", ");
  const title = level >= 100 ? `API spend is over budget (${Math.round(pct)}%)` : `API spend reached ${level}% of budget`;
  const body = [
    `${usd(sum.total)} of ${usd(settings.budget)} spent this month.`,
    `Projected month-end: ${usd(sum.projected)}.`,
    top ? `Top: ${top}.` : "",
  ]
    .filter(Boolean)
    .join("\n");
  await notify(env, title, body);
}
