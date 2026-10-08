import type { CostRow, Env } from "../env";
import { fetchJson } from "./http";

interface Bucket {
  starting_at: string;
  results: { amount: string; currency: string; description?: string | null; model?: string | null; cost_type?: string | null }[];
}

/** Anthropic Admin API cost report: GET /v1/organizations/cost_report (daily buckets, max 31 per page). */
export async function pullAnthropic(env: Env, from: string, to: string): Promise<CostRow[]> {
  const key = env.ANTHROPIC_ADMIN_KEY!;
  const divisor = (env.ANTHROPIC_AMOUNT_UNIT ?? "cents").toLowerCase() === "dollars" ? 1 : 100;
  const rows: CostRow[] = [];
  let page: string | undefined;
  for (let i = 0; i < 20; i++) {
    const q = new URLSearchParams({
      starting_at: from + "T00:00:00Z",
      ending_at: to + "T00:00:00Z",
      bucket_width: "1d",
      limit: "31",
    });
    q.append("group_by[]", "description");
    if (page) q.set("page", page);
    const res = await fetchJson<{ data: Bucket[]; has_more: boolean; next_page?: string | null }>(
      "https://api.anthropic.com/v1/organizations/cost_report?" + q,
      { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } },
    );
    for (const b of res.data) {
      const day = b.starting_at.slice(0, 10);
      for (const r of b.results) {
        const amount = parseFloat(r.amount) / divisor;
        if (!isFinite(amount)) continue;
        rows.push({ day, service: serviceName(r), amount, currency: r.currency || "USD" });
      }
    }
    if (!res.has_more || !res.next_page) break;
    page = res.next_page;
  }
  return rows;
}

function serviceName(r: { model?: string | null; description?: string | null; cost_type?: string | null }): string {
  if (r.model) return r.model;
  if (r.description) return r.description.replace(/\s*-\s*(Input|Output).*$/i, "");
  return r.cost_type || "Other";
}
