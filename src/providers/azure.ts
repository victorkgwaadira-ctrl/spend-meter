import type { CostRow, Env } from "../env";
import { fetchJson } from "./http";

let cachedToken: { value: string; exp: number } | null = null;

async function token(env: Env): Promise<string> {
  if (cachedToken && cachedToken.exp > Date.now() + 60_000) return cachedToken.value;
  const res = await fetchJson<{ access_token: string; expires_in: number }>(
    `https://login.microsoftonline.com/${env.AZURE_TENANT_ID}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: env.AZURE_CLIENT_ID!,
        client_secret: env.AZURE_CLIENT_SECRET!,
        scope: "https://management.azure.com/.default",
      }),
    },
  );
  cachedToken = { value: res.access_token, exp: Date.now() + res.expires_in * 1000 };
  return res.access_token;
}

interface QueryResult {
  properties: { columns: { name: string }[]; rows: unknown[][]; nextLink?: string | null };
}

/** Azure Cost Management Query API, daily actual cost by service, for each subscription. */
export async function pullAzure(env: Env, from: string, to: string): Promise<CostRow[]> {
  const subs = (env.AZURE_SUBSCRIPTION_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const bearer = await token(env);
  const lastDay = new Date(Date.parse(to + "T00:00:00Z") - 1000).toISOString().replace(/\.\d+Z$/, "Z");
  const body = JSON.stringify({
    type: "ActualCost",
    timeframe: "Custom",
    timePeriod: { from: from + "T00:00:00Z", to: lastDay },
    dataset: {
      granularity: "Daily",
      aggregation: { totalCost: { name: "Cost", function: "Sum" } },
      grouping: [{ type: "Dimension", name: "ServiceName" }],
    },
  });
  const rows: CostRow[] = [];
  for (const sub of subs) {
    let url: string | null | undefined =
      `https://management.azure.com/subscriptions/${sub}/providers/Microsoft.CostManagement/query?api-version=2023-11-01`;
    for (let i = 0; url && i < 20; i++) {
      const res: QueryResult = await fetchJson<QueryResult>(url, {
        method: "POST",
        headers: { Authorization: "Bearer " + bearer, "Content-Type": "application/json" },
        body,
      });
      const cols = res.properties.columns.map((c) => c.name.toLowerCase());
      const iCost = cols.findIndex((c) => c === "cost" || c === "totalcost" || c === "pretaxcost");
      const iDate = cols.indexOf("usagedate");
      const iSvc = cols.indexOf("servicename");
      const iCur = cols.indexOf("currency");
      for (const r of res.properties.rows) {
        const d = String(r[iDate]); // 20261007
        const day = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
        rows.push({
          day,
          service: String(r[iSvc] ?? "Other") || "Other",
          amount: Number(r[iCost]) || 0,
          currency: iCur >= 0 ? String(r[iCur]) : "USD",
        });
      }
      url = res.properties.nextLink;
    }
  }
  return rows;
}
