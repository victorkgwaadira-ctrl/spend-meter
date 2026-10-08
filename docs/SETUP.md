# Setup guide

Where to get each key, how to point provider webhooks at Spend Meter, and how each alert channel works. For API gateways, see [GATEWAYS.md](GATEWAYS.md).

## Connect providers

**The easy way:** open **Connections** on the dashboard, pick a provider or alert channel, paste its key and press **Test & save**. The key is checked live, stored encrypted in your database, and syncing starts straight away. You never need the terminal.

The steps below say where to get each key. Each also shows the `wrangler secret put` alternative, which takes priority over anything saved in the dashboard.

Dashboard-saved keys are encrypted with your dashboard password. If you change the password, re-enter them, or set a separate `ENCRYPTION_KEY` secret first.


### Anthropic
1. In the Claude Console, go to **Settings → Admin keys** and create a key. You need the organization admin role. Admin keys start with `sk-ant-admin`.
2. `npx wrangler secret put ANTHROPIC_ADMIN_KEY`

The cost report returns amounts in cents, and the Worker divides by 100. If totals ever look 100× too small, set `ANTHROPIC_AMOUNT_UNIT = "dollars"` in `wrangler.toml`.

### OpenAI
1. Go to **platform.openai.com → Organization settings → Admin keys** and create a key.
2. `npx wrangler secret put OPENAI_ADMIN_KEY`

### AWS: cost pulls
1. Enable Cost Explorer in the Billing console. It can take up to 24 hours to start.
2. Create an IAM user with only this policy:
   ```json
   { "Version": "2012-10-17", "Statement": [{ "Effect": "Allow", "Action": "ce:GetCostAndUsage", "Resource": "*" }] }
   ```
3. Create an access key for that user, then:
   ```bash
   npx wrangler secret put AWS_ACCESS_KEY_ID
   npx wrangler secret put AWS_SECRET_ACCESS_KEY
   ```

### AWS: budget webhook
1. Create an SNS topic. In its access policy, allow `budgets.amazonaws.com` to `SNS:Publish`.
2. Add an **HTTPS** subscription with your AWS webhook URL. It's on the dashboard under **Webhook URLs**. The Worker confirms the subscription automatically.
3. In **Billing → Budgets**, edit your budget's alerts and pick that SNS topic.
4. Optional: set `AWS_SNS_TOPIC_ARNS` to the topic ARN so only that topic is accepted.

### Azure: cost pulls
1. In **Microsoft Entra ID → App registrations**, create an app and add a client secret.
2. On each subscription, go to **Access control (IAM)** and give the app the **Cost Management Reader** role.
3. Add the secrets:
   ```bash
   npx wrangler secret put AZURE_TENANT_ID
   npx wrangler secret put AZURE_CLIENT_ID
   npx wrangler secret put AZURE_CLIENT_SECRET
   npx wrangler secret put AZURE_SUBSCRIPTION_IDS   # comma-separated
   ```

Amounts billed in pula are converted at 13.6 BWP per USD. Other currencies are counted as USD, and the sync status says so.

### Azure: budget webhook
1. Under **Monitor → Alerts → Action groups**, create an action group with a **Webhook** action pointing at your Azure webhook URL.
2. In **Cost Management → Budgets**, edit your budget's alert conditions and choose that action group.

### Google Cloud and Gemini
1. In **Billing → Budgets & alerts**, create a budget covering the whole billing account.
2. Under **Manage notifications**, tick **Connect a Pub/Sub topic to this budget** and create a topic.
3. In **Pub/Sub → Subscriptions**, create a subscription on that topic. Set the type to **Push** and the endpoint to your Google webhook URL.

Google sends an update several times a day. The dashboard turns those month-to-date totals into daily amounts.

Use one budget that covers everything for tracking. If several overlapping budgets point at the webhook, their costs are counted more than once.

### Twilio (optional)
In **Console → Usage → Triggers**, set the callback URL to your Twilio webhook URL.

### Any other API
Post costs or alerts from a script, Zapier, Make, or a provider's own webhook:

```bash
# a cost
curl -X POST "https://<your-worker>/hooks/generic?token=<WEBHOOK_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"provider":"Mapbox","service":"Geocoding","amount_usd":4.20,"category":"other"}'

# an alert
curl -X POST "https://<your-worker>/hooks/generic?token=<WEBHOOK_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"title":"Stripe fees high","message":"Fees are 30% above last month"}'
```

---

## Set up alert channels

Set up any combination. **Send test alert** on the dashboard checks them all.

| Channel | Setup | Secrets |
|---|---|---|
| **Telegram** | Message @BotFather, send `/newbot`, and copy the token. Send your bot any message, then open `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy `chat.id`. | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` |
| **Email** | Create a free Resend account and an API key. Until you verify a domain, Resend only delivers to your own account email. After verifying, set `ALERT_EMAIL_FROM` in `wrangler.toml`. | `RESEND_API_KEY`, `ALERT_EMAIL_TO` |
| **WhatsApp** | In Twilio, open **Messaging → Try it → WhatsApp** and join the sandbox from your phone. | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM` (`whatsapp:+14155238886`), `WHATSAPP_TO` (`whatsapp:+267…`) |
| **Slack** | Create a Slack app, turn on **Incoming Webhooks**, and add one to a channel. | `SLACK_WEBHOOK_URL` |
| **Teams** | In the channel, open **Workflows** and use **"Post to a channel when a webhook request is received"**. Copy the URL. | `TEAMS_WEBHOOK_URL` |

Paste them in **Connections**, or add each with `npx wrangler secret put <NAME>`.

**WhatsApp caveat:** the Twilio sandbox only delivers while your sandbox session is active, and WhatsApp blocks free-form messages more than 24 hours after you last messaged the number. For dependable WhatsApp alerts you need an approved WhatsApp Business sender and a message template. Until then, Telegram is the most reliable phone alert.

---

## How alerts work

- After every sync and every incoming cost, the Worker compares month-to-date spend (all providers plus manual entries) with your budget.
- Each level fires once a month. If spend jumps past several levels at once, you get one message for the highest.
- Provider budget webhooks (Google, AWS, Azure) are forwarded once per budget, per level, per month.
- Change the budget and alert levels under **Budget & alerts** on the dashboard.

## Security notes

- The dashboard uses HTTP Basic auth over HTTPS. Use a long password.
- Every webhook URL carries `WEBHOOK_TOKEN`, so treat those URLs like passwords. If one leaks, change the secret and update the URLs at each provider.
- Keys live only in Cloudflare secrets. The AWS key can only read cost data, and the Azure app only has Cost Management Reader.
