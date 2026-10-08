export interface Env {
  DB: D1Database;

  // Dashboard login (HTTP Basic auth; any username, this password)
  DASHBOARD_PASSWORD: string;
  // Shared secret every webhook URL must carry as ?token=...
  WEBHOOK_TOKEN: string;

  // Providers (each is optional; a provider is skipped when its keys are missing)
  ANTHROPIC_ADMIN_KEY?: string;
  ANTHROPIC_AMOUNT_UNIT?: string; // "cents" (default) | "dollars"
  OPENAI_ADMIN_KEY?: string;
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  AZURE_TENANT_ID?: string;
  AZURE_CLIENT_ID?: string;
  AZURE_CLIENT_SECRET?: string;
  AZURE_SUBSCRIPTION_IDS?: string; // comma-separated
  AWS_SNS_TOPIC_ARNS?: string; // optional comma-separated allow-list for /hooks/aws

  // Alert channels (each is optional)
  RESEND_API_KEY?: string;
  ALERT_EMAIL_TO?: string;
  ALERT_EMAIL_FROM?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_WHATSAPP_FROM?: string; // e.g. whatsapp:+14155238886
  WHATSAPP_TO?: string; // e.g. whatsapp:+26771234567
  SLACK_WEBHOOK_URL?: string;
  TEAMS_WEBHOOK_URL?: string;
}

export type ProviderId = "anthropic" | "openai" | "aws" | "azure" | "gcp";

export interface CostRow {
  day: string; // YYYY-MM-DD
  service: string;
  amount: number; // in `currency`
  currency: string;
}

export const PROVIDERS: Record<ProviderId, { name: string; category: "ai" | "cloud" }> = {
  anthropic: { name: "Anthropic", category: "ai" },
  openai: { name: "OpenAI", category: "ai" },
  gcp: { name: "Google Cloud", category: "cloud" },
  aws: { name: "AWS", category: "cloud" },
  azure: { name: "Azure", category: "cloud" },
};
