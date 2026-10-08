import type { Env } from "./env";
import { getSettings, logEvent, toUsd, utcDay } from "./db";
import { checkThresholds, notify } from "./alerts";

const ok = (msg = "ok") => new Response(msg, { status: 200 });
const bad = (msg: string, status = 400) => new Response(msg, { status });

/** Alert once per (scope, level) per month, for provider-side budget alerts. */
async function firstTime(env: Env, scope: string, level: number, detail: string): Promise<boolean> {
  const month = utcDay().slice(0, 7);
  const r = await env.DB.prepare("INSERT OR IGNORE INTO alerts(month, scope, level, sent_at, detail) VALUES(?,?,?,?,?)")
    .bind(month, scope, level, Date.now(), detail)
    .run();
  return r.meta.changes > 0;
}

/* ---------- AWS: Budgets -> SNS topic -> HTTPS subscription ---------- */
export async function awsHook(req: Request, env: Env): Promise<Response> {
  let msg: Record<string, string>;
  try {
    msg = JSON.parse(await req.text());
  } catch {
    return bad("Expected an SNS JSON message");
  }
  const allowed = (env.AWS_SNS_TOPIC_ARNS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (allowed.length && !allowed.includes(msg.TopicArn)) return bad("Topic not allowed", 403);

  if (msg.Type === "SubscriptionConfirmation") {
    const url = new URL(msg.SubscribeURL);
    if (url.protocol !== "https:" || !/^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/.test(url.hostname)) return bad("Unexpected SubscribeURL host", 403);
    const r = await fetch(url.toString());
    await logEvent(env, "aws", "subscription", r.ok ? `Confirmed SNS subscription to ${msg.TopicArn}` : `SNS confirmation failed (${r.status})`, msg);
    return ok("confirmed");
  }
  if (msg.Type === "Notification") {
    const text = String(msg.Message ?? "");
    const subject = msg.Subject || "AWS budget notification";
    await logEvent(env, "aws", "budget_alert", subject, msg);
    await notify(env, subject, text.slice(0, 1500));
    return ok();
  }
  return ok("ignored");
}

/* ---------- Google Cloud: Billing budget -> Pub/Sub push subscription ---------- */
interface GcpBudgetMsg {
  budgetDisplayName: string;
  alertThresholdExceeded?: number;
  costAmount: number;
  costIntervalStart?: string;
  budgetAmount: number;
  currencyCode: string;
}

export async function gcpHook(req: Request, env: Env): Promise<Response> {
  let env1: { message?: { data?: string; attributes?: Record<string, string> } };
  try {
    env1 = await req.json();
  } catch {
    return bad("Expected a Pub/Sub push message");
  }
  if (!env1.message?.data) return ok("no data");
  let m: GcpBudgetMsg;
  try {
    m = JSON.parse(atob(env1.message.data));
  } catch {
    return ok("unreadable data"); // 2xx so Pub/Sub does not retry forever
  }
  const settings = await getSettings(env);
  const budget = env1.message.attributes?.budgetId || m.budgetDisplayName;
  const today = utcDay();
  const monthStart = today.slice(0, 7) + "-01";

  // Turn month-to-date readings into a daily figure: today's MTD minus the last earlier reading this month.
  await env.DB.prepare(
    "INSERT INTO gcp_snapshots(budget, day, cost_mtd, currency, observed_at) VALUES(?,?,?,?,?) " +
      "ON CONFLICT(budget, day) DO UPDATE SET cost_mtd = MAX(cost_mtd, excluded.cost_mtd), observed_at = excluded.observed_at",
  )
    .bind(budget, today, m.costAmount, m.currencyCode, Date.now())
    .run();
  const prev = await env.DB.prepare("SELECT MAX(cost_mtd) AS v FROM gcp_snapshots WHERE budget = ? AND day >= ? AND day < ?")
    .bind(budget, monthStart, today)
    .first<{ v: number | null }>();
  const todayMtd = await env.DB.prepare("SELECT cost_mtd FROM gcp_snapshots WHERE budget = ? AND day = ?").bind(budget, today).first<{ cost_mtd: number }>();
  const dailyAmount = Math.max(0, (todayMtd?.cost_mtd ?? m.costAmount) - (prev?.v ?? 0));
  await env.DB.prepare(
    "INSERT INTO costs(provider, day, service, amount_usd, currency, source, updated_at) VALUES('gcp',?,?,?,?,'webhook',?) " +
      "ON CONFLICT(provider, day, service) DO UPDATE SET amount_usd = excluded.amount_usd, currency = excluded.currency, updated_at = excluded.updated_at",
  )
    .bind(today, "Budget: " + m.budgetDisplayName, toUsd(dailyAmount, m.currencyCode, settings.fx), m.currencyCode, Date.now())
    .run();

  const pct = m.budgetAmount ? Math.round((m.costAmount / m.budgetAmount) * 100) : 0;
  await logEvent(env, "gcp", "budget_update", `${m.budgetDisplayName}: ${m.costAmount} ${m.currencyCode} of ${m.budgetAmount} (${pct}%)`, m);

  if (m.alertThresholdExceeded) {
    const level = Math.round(m.alertThresholdExceeded * 100);
    if (await firstTime(env, "gcp:" + budget, level, `${pct}%`)) {
      await notify(
        env,
        `Google Cloud budget "${m.budgetDisplayName}" passed ${level}%`,
        `${m.costAmount.toFixed(2)} ${m.currencyCode} of ${m.budgetAmount.toFixed(2)} ${m.currencyCode} this month (${pct}%).`,
      );
    }
  }
  await checkThresholds(env);
  return ok();
}

/* ---------- Azure: Budget -> Action group -> Webhook ---------- */
export async function azureHook(req: Request, env: Env): Promise<Response> {
  let p: Record<string, any>;
  try {
    p = await req.json();
  } catch {
    return bad("Expected JSON");
  }
  const d = p.data ?? p;
  const name = d.BudgetName ?? d.budgetName ?? d.essentials?.alertRule ?? "Azure budget";
  const spent = Number(d.SpentAmount ?? d.spentAmount ?? NaN);
  const budget = Number(d.BudgetAmount ?? d.budgetAmount ?? NaN);
  const threshold = Number(d.NotificationThresholdAmount ?? d.notificationThresholdAmount ?? NaN);
  const unit = d.Unit ?? d.unit ?? "";
  const pct = isFinite(spent) && budget ? Math.round((spent / budget) * 100) : NaN;
  const summary = isFinite(spent) ? `${name}: ${spent} ${unit} of ${budget} ${unit}${isFinite(pct) ? ` (${pct}%)` : ""}` : `${name}: alert received`;
  await logEvent(env, "azure", "budget_alert", summary, p);
  const level = isFinite(threshold) && budget ? Math.round((threshold / budget) * 100) : isFinite(pct) ? pct : 0;
  if (await firstTime(env, "azure:" + name, level, summary)) {
    await notify(env, `Azure budget alert: ${name}`, summary);
  }
  return ok();
}

/* ---------- Twilio: Usage Triggers callback (form-encoded) ---------- */
export async function twilioHook(req: Request, env: Env): Promise<Response> {
  const f = await req.formData();
  const cat = String(f.get("UsageCategory") ?? "usage");
  const cur = String(f.get("CurrentValue") ?? "");
  const trig = String(f.get("TriggerValue") ?? "");
  const summary = `Twilio ${cat}: ${cur} (trigger at ${trig})`;
  await logEvent(env, "twilio", "usage_trigger", summary, Object.fromEntries(f as unknown as Iterable<[string, string]>));
  await notify(env, "Twilio usage trigger", summary);
  return ok();
}

/* ---------- Generic: anything else can post costs or alerts ---------- */
// Cost:  {"provider":"Mapbox","service":"Geocoding","amount_usd":4.20,"day":"2026-10-07","category":"other"}
// Alert: {"title":"Stripe Radar spend high","message":"..."}
export async function genericHook(req: Request, env: Env): Promise<Response> {
  let p: Record<string, any>;
  try {
    p = await req.json();
  } catch {
    return bad("Expected JSON");
  }
  if (typeof p.amount_usd === "number" && p.provider) {
    const day = /^\d{4}-\d{2}-\d{2}$/.test(p.day) ? p.day : utcDay();
    const category = ["ai", "cloud", "other"].includes(p.category) ? p.category : "other";
    const id = "hook-" + crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO entries(id, day, category, provider, service, usage, amount_usd, note, created_at) VALUES(?,?,?,?,?,?,?,?,?)",
    )
      .bind(id, day, category, String(p.provider).slice(0, 100), String(p.service ?? "API").slice(0, 100), p.usage ? String(p.usage).slice(0, 200) : "Webhook", p.amount_usd, p.note ? String(p.note).slice(0, 300) : null, Date.now())
      .run();
    await logEvent(env, "generic", "cost", `${p.provider}: $${p.amount_usd}`, p);
    await checkThresholds(env);
    return ok(id);
  }
  if (p.title || p.message) {
    await logEvent(env, "generic", "alert", String(p.title ?? p.message).slice(0, 200), p);
    await notify(env, String(p.title ?? "API alert"), String(p.message ?? ""));
    return ok();
  }
  return bad('Send {"provider","amount_usd"} for a cost or {"title","message"} for an alert');
}
