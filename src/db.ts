import type { CostRow, Env, ProviderId } from "./env";
import type { PriceRule } from "./gateways";

export interface Settings {
  budget: number; // monthly, USD
  fx: number; // BWP per 1 USD
  levels: number[]; // alert thresholds, percent of budget
  rates: { id: string; provider: string; model: string; in: number; out: number }[];
  priceRules: PriceRule[]; // gateway traffic pricing, USD per 1,000 requests
}

export const DEFAULT_SETTINGS: Settings = {
  budget: 300,
  fx: 13.6,
  levels: [50, 80, 100],
  rates: [
    { id: "r1", provider: "Anthropic", model: "Claude Sonnet 4.5", in: 3, out: 15 },
    { id: "r2", provider: "Anthropic", model: "Claude Haiku 4.5", in: 1, out: 5 },
    { id: "r3", provider: "OpenAI", model: "GPT-4o", in: 2.5, out: 10 },
    { id: "r4", provider: "Google", model: "Gemini 2.5 Pro", in: 1.25, out: 10 },
  ],
  priceRules: [],
};

export async function getSettings(env: Env): Promise<Settings> {
  const { results } = await env.DB.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
  const s: Settings = structuredClone(DEFAULT_SETTINGS);
  for (const r of results) {
    try {
      (s as unknown as Record<string, unknown>)[r.key] = JSON.parse(r.value);
    } catch {
      /* ignore malformed */
    }
  }
  return s;
}

export async function saveSettings(env: Env, patch: Partial<Settings>): Promise<void> {
  const allowed: (keyof Settings)[] = ["budget", "fx", "levels", "rates", "priceRules"];
  const stmts = allowed
    .filter((k) => k in patch)
    .map((k) =>
      env.DB.prepare("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(
        k,
        JSON.stringify(patch[k]),
      ),
    );
  if (stmts.length) await env.DB.batch(stmts);
}

/** Convert a provider amount to USD. BWP is converted with the dashboard rate; other currencies pass through. */
export function toUsd(amount: number, currency: string, fx: number): number {
  const c = currency.toUpperCase();
  if (c === "BWP" && fx > 0) return amount / fx;
  return amount;
}

/**
 * Replace a provider's API rows for the days [fromDay, toDay) with fresh ones.
 * Rows from webhooks are left alone.
 */
export async function replaceCosts(env: Env, provider: ProviderId, fromDay: string, toDay: string, rows: CostRow[], fx: number) {
  // Merge duplicate (day, service) pairs first
  const merged = new Map<string, CostRow>();
  for (const r of rows) {
    const k = r.day + "|" + r.service;
    const prev = merged.get(k);
    if (prev) prev.amount += r.amount;
    else merged.set(k, { ...r });
  }
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare("DELETE FROM costs WHERE provider = ? AND source = 'api' AND day >= ? AND day < ?").bind(provider, fromDay, toDay),
  ];
  for (const r of merged.values()) {
    if (Math.abs(r.amount) < 1e-9) continue;
    stmts.push(
      env.DB.prepare(
        "INSERT INTO costs(provider, day, service, amount_usd, currency, source, updated_at) VALUES(?,?,?,?,?,'api',?) " +
          "ON CONFLICT(provider, day, service) DO UPDATE SET amount_usd = excluded.amount_usd, currency = excluded.currency, source = 'api', updated_at = excluded.updated_at",
      ).bind(provider, r.day, r.service.slice(0, 200), toUsd(r.amount, r.currency, fx), r.currency.toUpperCase(), now),
    );
  }
  // D1 batches run as one transaction
  for (let i = 0; i < stmts.length; i += 90) await env.DB.batch(stmts.slice(i, i + 90));
}

export async function recordRun(env: Env, provider: string, ok: boolean, message: string) {
  await env.DB.prepare(
    "INSERT INTO runs(provider, ran_at, ok, message) VALUES(?,?,?,?) ON CONFLICT(provider) DO UPDATE SET ran_at=excluded.ran_at, ok=excluded.ok, message=excluded.message",
  )
    .bind(provider, Date.now(), ok ? 1 : 0, message.slice(0, 500))
    .run();
}

export async function logEvent(env: Env, provider: string, kind: string, summary: string, payload: unknown) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  await env.DB.prepare("INSERT INTO events(provider, kind, summary, payload, received_at) VALUES(?,?,?,?,?)")
    .bind(provider, kind, summary.slice(0, 500), (body ?? "").slice(0, 20000), Date.now())
    .run();
  // keep the table small
  await env.DB.prepare("DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT 500)").run();
}

export function utcDay(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(day: string, n: number): string {
  const d = new Date(day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return utcDay(d);
}

/** Sync window: this month to date, plus last month during the first 3 days (late-arriving charges). */
export function syncWindow(now = new Date()): { from: string; to: string } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const start = now.getUTCDate() <= 3 ? new Date(Date.UTC(y, m - 1, 1)) : new Date(Date.UTC(y, m, 1));
  return { from: utcDay(start), to: addDays(utcDay(now), 1) };
}
