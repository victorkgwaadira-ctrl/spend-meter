import type { Env } from "./env";
import { DEFAULT_SETTINGS } from "./db";
import { GATEWAYS } from "./gateways";
import { connectionStatus } from "./connections";
import type { Item, MonthSummary, Traffic } from "./summary";

/**
 * Sample data for the public /demo dashboard. Generated on the fly and
 * deterministic per day, so it never touches the database or real keys.
 */

const pad = (n: number) => String(n).padStart(2, "0");

function rng(seed: number) {
  let s = seed % 2147483647 || 1;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

const SOURCES: { id: string; name: string; category: "ai" | "cloud" | "other"; service: string; base: number; swing: number; source: Item["source"] }[] = [
  { id: "anthropic", name: "Anthropic", category: "ai", service: "claude-sonnet-4-5", base: 34, swing: 18, source: "api" },
  { id: "anthropic", name: "Anthropic", category: "ai", service: "claude-haiku-4-5", base: 6, swing: 4, source: "api" },
  { id: "openai", name: "OpenAI", category: "ai", service: "gpt-4o", base: 17, swing: 10, source: "api" },
  { id: "openai", name: "OpenAI", category: "ai", service: "text-embedding-3-large", base: 2.5, swing: 1.5, source: "api" },
  { id: "aws", name: "AWS", category: "cloud", service: "Amazon EC2", base: 9.5, swing: 2, source: "api" },
  { id: "aws", name: "AWS", category: "cloud", service: "Amazon S3", base: 1.8, swing: 0.6, source: "api" },
  { id: "gcp", name: "Google Cloud", category: "cloud", service: "Budget: All billing", base: 4.2, swing: 2.2, source: "webhook" },
];

function monthDays(month: string) {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function buildMonth(month: string, budget: number): MonthSummary {
  const now = new Date();
  const curMonth = now.toISOString().slice(0, 7);
  const isCurrent = month === curMonth;
  const dim = monthDays(month);
  const lastDay = isCurrent ? now.getUTCDate() : dim;
  const items: Item[] = [];
  const [y, m] = month.split("-").map(Number);

  for (let d = 1; d <= lastDay; d++) {
    const day = `${month}-${pad(d)}`;
    const r = rng(y * 1000 + m * 40 + d);
    const weekend = [0, 6].includes(new Date(Date.UTC(y, m - 1, d)).getUTCDay());
    // A runaway batch job: one expensive day mid-month, the story the alerts are for
    const spike = d === Math.min(lastDay, 6) && isCurrent ? 2.6 : 1;
    for (const s of SOURCES) {
      let amt = (s.base + (r() - 0.5) * 2 * s.swing) * (weekend && s.category === "ai" ? 0.55 : 1);
      if (s.service === "claude-sonnet-4-5") amt *= spike;
      if (amt <= 0) continue;
      items.push({ id: `demo|${s.id}|${day}|${s.service}`, day, source: s.source, providerId: s.id, provider: s.name, category: s.category, service: s.service, amount: amt, currency: "USD" });
    }
    if (d % 7 === 2) {
      items.push({ id: `demo|m|${day}`, day, source: "manual", providerId: "manual:twilio", provider: "Twilio", category: "other", service: "SMS", usage: "1,240 messages × $0.0079", amount: 9.8, note: "OTP codes" });
    }
  }

  // Gateway traffic, priced at $0.40 per 1,000 requests
  const traffic: Traffic[] = [];
  const gw = [
    { gateway: "kong", api: "orders", req: 41200, e4: 610, e5: 38, lat: 84 },
    { gateway: "kong", api: "payments", req: 12800, e4: 140, e5: 9, lat: 212 },
    { gateway: "aws-api-gateway", api: "/prod/search", req: 96300, e4: 1210, e5: 410, lat: 46 },
    { gateway: "kong", api: "auth", req: 58900, e4: 2300, e5: 3, lat: 19 },
  ];
  const share = lastDay / dim;
  for (const g of gw) {
    const requests = Math.round(g.req * share);
    const cost = (requests / 1000) * 0.4;
    traffic.push({
      gateway: g.gateway,
      gatewayName: GATEWAYS[g.gateway].name,
      api: g.api,
      requests,
      err4xx: Math.round(g.e4 * share),
      err5xx: Math.round(g.e5 * share),
      avgLatencyMs: g.lat,
      bytes: requests * 900,
      consumers: g.api === "auth" ? 14 : 6,
      per1k: 0.4,
      cost,
      lastAt: Date.now() - 4 * 60_000,
    });
    // Priced gateway traffic shows up as cost items, spread across the days
    for (let d = 1; d <= lastDay; d++) {
      items.push({
        id: `demo|gw|${g.gateway}|${g.api}|${d}`,
        day: `${month}-${pad(d)}`,
        source: "gateway",
        providerId: "gw:" + g.gateway,
        provider: GATEWAYS[g.gateway].name,
        category: "other",
        service: g.api,
        usage: `${Math.round(requests / lastDay).toLocaleString("en-US")} requests × $0.4/1k`,
        amount: cost / lastDay,
      });
    }
  }

  const daily = Array.from({ length: dim }, () => ({ ai: 0, cloud: 0, other: 0 }));
  const byProv = new Map<string, { id: string; name: string; category: string; amount: number }>();
  let total = 0;
  for (const it of items) {
    total += it.amount;
    daily[Number(it.day.slice(8)) - 1][it.category] += it.amount;
    const p = byProv.get(it.providerId) ?? { id: it.providerId, name: it.provider, category: it.category, amount: 0 };
    p.amount += it.amount;
    byProv.set(it.providerId, p);
  }
  items.sort((a, b) => b.day.localeCompare(a.day) || b.amount - a.amount);
  return {
    month,
    daysInMonth: dim,
    elapsed: lastDay,
    isCurrent,
    total,
    projected: isCurrent ? (total / lastDay) * dim : total,
    budget,
    byProvider: [...byProv.values()].sort((a, b) => b.amount - a.amount),
    daily,
    items,
    traffic: traffic.sort((a, b) => b.requests - a.requests),
  };
}

export function demoState(url: URL) {
  const now = new Date();
  const cur = now.toISOString().slice(0, 7);
  const prevDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const prev = prevDate.toISOString().slice(0, 7);
  const asked = url.searchParams.get("month");
  const month = asked === prev ? prev : cur;
  const budget = 2400;
  const settings = {
    ...structuredClone(DEFAULT_SETTINGS),
    budget,
    priceRules: [{ id: "p1", gateway: "*", api: "*", per1k: 0.4 }],
  };
  const summary = buildMonth(month, budget);
  const H = 3600_000;
  const t = Date.now();

  // Alerts that would have fired for the shown month
  const pct = (summary.total / budget) * 100;
  const alerts = settings.levels
    .filter((l) => pct >= l)
    .map((l, i) => ({ scope: "total", level: l, sent_at: t - (3 - i) * 26 * H, detail: `${Math.round(l + 1)}%` }))
    .reverse();

  const demoEnv = {
    ANTHROPIC_ADMIN_KEY: "sk-ant-admin01-demo0000a1F3",
    OPENAI_ADMIN_KEY: "sk-admin-demo00009c2E",
    AWS_ACCESS_KEY_ID: "AKIADEMO7EXAMPLE",
    AWS_SECRET_ACCESS_KEY: "demo/secret/kQ2x",
    TELEGRAM_BOT_TOKEN: "8000000000:AAdemo",
    TELEGRAM_CHAT_ID: "612345678",
    RESEND_API_KEY: "re_demo_9Lm4",
    ALERT_EMAIL_TO: "team@example.com",
    SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/T000/B000/demoX7pQ",
  } as unknown as Env;

  const base = url.origin;
  return {
    demo: true,
    month,
    months: [cur, prev],
    settings,
    summary,
    runs: [
      { provider: "anthropic", ran_at: t - 12 * 60_000, ok: 1, message: "Synced 58 line items" },
      { provider: "openai", ran_at: t - 14 * 60_000, ok: 1, message: "Synced 31 line items" },
      { provider: "aws", ran_at: t - 2.4 * H, ok: 1, message: "Synced 19 line items" },
    ],
    events: [
      { provider: "kong", kind: "batch", summary: "Kong Gateway: 1,840 requests received", received_at: t - 4 * 60_000 },
      { provider: "gcp", kind: "budget_update", summary: "All billing: 31.40 USD of 150 (21%)", received_at: t - 3.1 * H },
      { provider: "aws-api-gateway", kind: "batch", summary: "Amazon API Gateway: 6,210 requests received", received_at: t - 5.2 * H },
    ],
    alerts,
    channels: { email: true, telegram: true, whatsapp: false, slack: true, teams: false },
    providers: {
      anthropic: { name: "Anthropic", connected: true, pulls: true },
      openai: { name: "OpenAI", connected: true, pulls: true },
      gcp: { name: "Google Cloud", connected: null, pulls: false },
      aws: { name: "AWS", connected: true, pulls: true },
      azure: { name: "Azure", connected: false, pulls: true },
    },
    connections: connectionStatus({} as Env, demoEnv, { unreadable: [], updated: {} }),
    webhooks: {
      gcp: `${base}/hooks/gcp?token=your-token`,
      aws: `${base}/hooks/aws?token=your-token`,
      azure: `${base}/hooks/azure?token=your-token`,
      twilio: `${base}/hooks/twilio?token=your-token`,
      generic: `${base}/hooks/generic?token=your-token`,
    },
    gatewayBase: `${base}/hooks/gateway/`,
    webhookToken: "your-token",
    gateways: Object.fromEntries(
      Object.entries(GATEWAYS).map(([slug, g]) => [
        slug,
        { ...g, lastAt: slug === "kong" ? t - 4 * 60_000 : slug === "aws-api-gateway" ? t - 5.2 * H : null, requests: slug === "kong" ? 412_000 : slug === "aws-api-gateway" ? 388_000 : 0 },
      ]),
    ),
  };
}
