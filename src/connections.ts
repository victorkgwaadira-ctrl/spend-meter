import type { Env } from "./env";
import { addDays, utcDay } from "./db";
import { sendOne, telegramChat, telegramToken, type Channel } from "./alerts";
import { pullAnthropic } from "./providers/anthropic";
import { pullOpenAI } from "./providers/openai";
import { pullAws } from "./providers/aws";
import { pullAzure } from "./providers/azure";

/**
 * Connections entered in the dashboard. Values are encrypted (AES-GCM) in the
 * `credentials` table. A Cloudflare secret with the same name always wins, so
 * anything set with `wrangler secret put` keeps working unchanged.
 */

type Field = { key: keyof Env & string; label: string; secret: boolean; placeholder?: string; optional?: boolean };
export interface Integration {
  id: string;
  name: string;
  kind: "provider" | "channel";
  help: string; // where to get the key
  helpUrl: string;
  fields: Field[];
}

export const INTEGRATIONS: Integration[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    kind: "provider",
    help: "Console → Settings → Admin keys. Needs an organization account and the admin role.",
    helpUrl: "https://console.anthropic.com/settings/admin-keys",
    fields: [{ key: "ANTHROPIC_ADMIN_KEY", label: "Admin key", secret: true, placeholder: "sk-ant-admin01-…" }],
  },
  {
    id: "openai",
    name: "OpenAI",
    kind: "provider",
    help: "Organization settings → Admin keys.",
    helpUrl: "https://platform.openai.com/settings/organization/admin-keys",
    fields: [{ key: "OPENAI_ADMIN_KEY", label: "Admin key", secret: true, placeholder: "sk-admin-…" }],
  },
  {
    id: "aws",
    name: "AWS",
    kind: "provider",
    help: "IAM user allowed only ce:GetCostAndUsage. Each sync costs $0.01; testing runs one.",
    helpUrl: "https://console.aws.amazon.com/iam/home#/users",
    fields: [
      { key: "AWS_ACCESS_KEY_ID", label: "Access key ID", secret: false, placeholder: "AKIA…" },
      { key: "AWS_SECRET_ACCESS_KEY", label: "Secret access key", secret: true },
    ],
  },
  {
    id: "azure",
    name: "Azure",
    kind: "provider",
    help: "App registration with a client secret and the Cost Management Reader role on each subscription.",
    helpUrl: "https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
    fields: [
      { key: "AZURE_TENANT_ID", label: "Tenant ID", secret: false },
      { key: "AZURE_CLIENT_ID", label: "Client ID", secret: false },
      { key: "AZURE_CLIENT_SECRET", label: "Client secret", secret: true },
      { key: "AZURE_SUBSCRIPTION_IDS", label: "Subscription IDs (comma-separated)", secret: false },
    ],
  },
  {
    id: "telegram",
    name: "Telegram",
    kind: "channel",
    help: "Token from @BotFather. Chat ID from api.telegram.org/bot<token>/getUpdates after messaging your bot.",
    helpUrl: "https://t.me/BotFather",
    fields: [
      { key: "TELEGRAM_BOT_TOKEN", label: "Bot token", secret: true, placeholder: "8900000000:AA…" },
      { key: "TELEGRAM_CHAT_ID", label: "Chat ID", secret: false, placeholder: "612345678" },
    ],
  },
  {
    id: "email",
    name: "Email",
    kind: "channel",
    help: "Free Resend API key. Until you verify a domain, Resend only delivers to your own account email.",
    helpUrl: "https://resend.com/api-keys",
    fields: [
      { key: "RESEND_API_KEY", label: "Resend API key", secret: true, placeholder: "re_…" },
      { key: "ALERT_EMAIL_TO", label: "Send alerts to", secret: false, placeholder: "you@example.com" },
    ],
  },
  {
    id: "whatsapp",
    name: "WhatsApp",
    kind: "channel",
    help: "Twilio account, joined to the WhatsApp sandbox from your phone.",
    helpUrl: "https://console.twilio.com/us1/develop/sms/try-it-out/whatsapp-learn",
    fields: [
      { key: "TWILIO_ACCOUNT_SID", label: "Account SID", secret: false, placeholder: "AC…" },
      { key: "TWILIO_AUTH_TOKEN", label: "Auth token", secret: true },
      { key: "TWILIO_WHATSAPP_FROM", label: "From", secret: false, placeholder: "whatsapp:+14155238886" },
      { key: "WHATSAPP_TO", label: "To", secret: false, placeholder: "whatsapp:+267…" },
    ],
  },
  {
    id: "slack",
    name: "Slack",
    kind: "channel",
    help: "Slack app → Incoming Webhooks → Add to a channel.",
    helpUrl: "https://api.slack.com/apps",
    fields: [{ key: "SLACK_WEBHOOK_URL", label: "Webhook URL", secret: true, placeholder: "https://hooks.slack.com/services/…" }],
  },
  {
    id: "teams",
    name: "Teams",
    kind: "channel",
    help: "In the channel: Workflows → “Post to a channel when a webhook request is received”.",
    helpUrl: "https://support.microsoft.com/office/create-incoming-webhooks-with-workflows-for-microsoft-teams-8ae491c7-0394-4861-ba59-055e33f75498",
    fields: [{ key: "TEAMS_WEBHOOK_URL", label: "Workflow URL", secret: true }],
  },
];

const ALLOWED = new Set(INTEGRATIONS.flatMap((i) => i.fields.map((f) => f.key)));

/* ---------------- encryption ---------------- */

async function aesKey(env: Env): Promise<CryptoKey> {
  const master = (env as any).ENCRYPTION_KEY || env.DASHBOARD_PASSWORD || "";
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(master), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("api-spend-meter/credentials/v1"), info: new Uint8Array() },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
const b64e = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const b64d = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function encrypt(env: Env, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(env), new TextEncoder().encode(plain)));
  return b64e(iv) + "." + b64e(ct);
}
async function decrypt(env: Env, blob: string): Promise<string | null> {
  try {
    const [iv, ct] = blob.split(".");
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64d(iv) }, await aesKey(env), b64d(ct));
    return new TextDecoder().decode(pt);
  } catch {
    return null; // encryption key changed (e.g. new dashboard password)
  }
}

/* ---------------- loading ---------------- */

let tableReady = false;

export interface StoredInfo {
  unreadable: string[]; // stored but can't be decrypted
  updated: Record<string, number>;
}

/** Return env with dashboard-entered credentials filled in wherever no Cloudflare secret is set. */
export async function withStoredCreds(env: Env): Promise<{ env: Env; info: StoredInfo }> {
  const info: StoredInfo = { unreadable: [], updated: {} };
  let rows: { key: string; value: string; updated_at: number }[] = [];
  try {
    if (!tableReady) {
      await env.DB.prepare("CREATE TABLE IF NOT EXISTS credentials (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)").run();
      tableReady = true;
    }
    rows = (await env.DB.prepare("SELECT key, value, updated_at FROM credentials").all<{ key: string; value: string; updated_at: number }>()).results;
  } catch {
    return { env, info };
  }
  const merged: Record<string, unknown> = { ...env };
  for (const r of rows) {
    info.updated[r.key] = r.updated_at;
    if ((env as any)[r.key]) continue; // Cloudflare secret wins
    const v = await decrypt(env, r.value);
    if (v == null) info.unreadable.push(r.key);
    else merged[r.key] = v;
  }
  return { env: merged as unknown as Env, info };
}

/** Status for the dashboard. Never returns secret values. */
export function connectionStatus(raw: Env, eff: Env, info: StoredInfo) {
  return INTEGRATIONS.map((i) => {
    const fields = i.fields.map((f) => {
      const fromSecret = !!(raw as any)[f.key];
      const fromDash = !fromSecret && !!(eff as any)[f.key];
      const val = String((eff as any)[f.key] ?? "");
      return {
        key: f.key,
        label: f.label,
        secret: f.secret,
        placeholder: f.placeholder ?? "",
        set: fromSecret || fromDash,
        source: fromSecret ? "cloudflare" : fromDash ? "dashboard" : info.unreadable.includes(f.key) ? "unreadable" : null,
        preview: !val ? "" : f.secret ? "••••" + val.slice(-4) : val.length > 40 ? val.slice(0, 18) + "…" + val.slice(-8) : val,
      };
    });
    const set = fields.filter((f) => f.set).length;
    return {
      id: i.id,
      name: i.name,
      kind: i.kind,
      help: i.help,
      helpUrl: i.helpUrl,
      fields,
      state: set === fields.length ? "connected" : fields.some((f) => f.source === "unreadable") ? "reenter" : set ? "partial" : "off",
      lockedBySecret: fields.some((f) => f.source === "cloudflare"),
    };
  });
}

/* ---------------- testing + saving ---------------- */

async function test(id: string, env: Env): Promise<string> {
  const today = utcDay();
  const from = addDays(today, -2);
  const to = addDays(today, 1);
  switch (id) {
    case "anthropic": {
      const rows = await pullAnthropic(env, from, to);
      return `Connected. Read ${rows.length} cost line${rows.length === 1 ? "" : "s"} from the last 2 days.`;
    }
    case "openai": {
      const rows = await pullOpenAI(env, from, to);
      return `Connected. Read ${rows.length} cost line${rows.length === 1 ? "" : "s"} from the last 2 days.`;
    }
    case "aws": {
      const rows = await pullAws(env, from, to);
      return `Connected. Read ${rows.length} cost line${rows.length === 1 ? "" : "s"} from the last 2 days.`;
    }
    case "azure": {
      const rows = await pullAzure(env, from, to);
      return `Connected. Read ${rows.length} cost line${rows.length === 1 ? "" : "s"} from the last 2 days.`;
    }
    default: {
      await sendOne(env, id as Channel, "API Spend Meter connected", `${INTEGRATIONS.find((i) => i.id === id)?.name} alerts will arrive here.`);
      return "Connected. A test message is on its way.";
    }
  }
}

function clean(key: string, v: string): string {
  let s = v.trim().replace(/[\u0000-\u001f\u007f▬]/g, ""); // stray control characters and ▬ from Windows terminals
  if (key === "TELEGRAM_BOT_TOKEN") s = telegramToken(s) ?? s;
  if (key === "TELEGRAM_CHAT_ID") s = telegramChat(s) ?? s;
  if (key === "AZURE_SUBSCRIPTION_IDS") s = s.split(/[\s,;]+/).filter(Boolean).join(",");
  if ((key === "TWILIO_WHATSAPP_FROM" || key === "WHATSAPP_TO") && s && !s.startsWith("whatsapp:")) s = "whatsapp:" + s.replace(/\s/g, "");
  return s;
}

/**
 * Test the given values (blank fields keep their saved value), then save them encrypted.
 * With force, saves even if the test fails.
 */
export async function connect(raw: Env, eff: Env, id: string, values: Record<string, string>, force: boolean) {
  const integ = INTEGRATIONS.find((i) => i.id === id);
  if (!integ) return { ok: false, message: "Unknown connection." };
  const updates: Record<string, string> = {};
  for (const f of integ.fields) {
    const v = values[f.key];
    if (typeof v === "string" && v.trim()) updates[f.key] = clean(f.key, v).slice(0, 2000);
  }
  const trial = { ...(eff as any), ...updates } as Env;
  const missing = integ.fields.filter((f) => !f.optional && !(trial as any)[f.key]).map((f) => f.label);
  if (missing.length) return { ok: false, message: `Fill in: ${missing.join(", ")}.` };

  let message: string;
  let ok = true;
  try {
    message = await test(id, trial);
  } catch (e) {
    ok = false;
    message = ((e as Error).message || String(e)).replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot<token>");
  }
  if (!ok && !force) return { ok: false, message, canForce: true };

  const now = Date.now();
  const stmts = [];
  for (const [k, v] of Object.entries(updates)) {
    if (!ALLOWED.has(k as any)) continue;
    stmts.push(
      raw.DB.prepare("INSERT INTO credentials(key, value, updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(
        k,
        await encrypt(raw, v),
        now,
      ),
    );
  }
  if (stmts.length) await raw.DB.batch(stmts);
  const shadowed = Object.keys(updates).filter((k) => (raw as any)[k]);
  if (shadowed.length) message += ` Note: a Cloudflare secret for ${shadowed.join(", ")} is still set and takes priority. Delete it in Cloudflare to use this value.`;
  return { ok: true, saved: true, testPassed: ok, message: ok ? message : "Saved without a successful test: " + message };
}

export async function disconnect(raw: Env, id: string) {
  const integ = INTEGRATIONS.find((i) => i.id === id);
  if (!integ) return { ok: false, message: "Unknown connection." };
  const keys = integ.fields.map((f) => f.key);
  await raw.DB.prepare(`DELETE FROM credentials WHERE key IN (${keys.map(() => "?").join(",")})`).bind(...keys).run();
  const still = keys.filter((k) => (raw as any)[k]);
  return {
    ok: true,
    message: still.length
      ? `Removed the dashboard copy. ${integ.name} is still connected through Cloudflare secrets (${still.join(", ")}); delete those in Cloudflare to disconnect fully.`
      : `${integ.name} disconnected.`,
  };
}
