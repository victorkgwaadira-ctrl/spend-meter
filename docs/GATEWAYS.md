# Connecting API gateways

Each gateway sends its request logs to:

```
https://<your-worker>/hooks/gateway/<gateway>?token=<WEBHOOK_TOKEN>
```

The dashboard's **Connect a gateway** panel shows the exact URL for each one.

The meter counts requests, 4xx and 5xx errors, latency and bytes per gateway, API and consumer, per day. Traffic turns into cost only when it matches a price under **Gateway pricing** (USD per 1,000 requests). Priced traffic counts toward your budget and its 50/80/100% alerts.

**What the endpoint accepts**
- **Formats:** a JSON object, a JSON array, newline-delimited JSON, or plain access-log lines (NGINX/Apache combined, KrakenD/Gin).
- **Wrappers:** Amazon Data Firehose, CloudWatch Logs, Google Pub/Sub and Cloud Logging entries, and OCI log entries.
- **Compression:** gzip bodies, up to 10 MB per post.
- **Token:** in the URL (`?token=`), or as an `X-Webhook-Token`, `Authorization: Bearer` or `X-Amz-Firehose-Access-Key` header.

If a gateway posts something the meter can't read, the **Activity** feed shows "found no request records", with a sample saved for debugging.

---

## The standard record

Wherever you can choose the log format, send these fields. All are optional except `status` plus either `method` or `path`.

```json
{"api":"orders","method":"GET","path":"/v1/orders/123","status":200,
 "consumer":"mobile-app","latency_ms":42,"bytes":512,"ts":"2026-10-07T20:00:00Z","count":1}
```

- `api` groups traffic. If it's missing, the meter uses the first three path segments, with IDs collapsed (`/v1/orders/:id`).
- `consumer` should be a name or app ID. Anything that looks like a raw API key is stored as its last six characters.
- `count` lets you send pre-aggregated rows, e.g. `{"api":"search","status":200,"count":500}`.

---

## Shipping log files

Many gateways write access logs to a file or stdout rather than posting them. Use either shipper to forward them.

**Fluent Bit**
```ini
[INPUT]
    Name   tail
    Path   /var/log/gateway/access.log
    Tag    gw

[OUTPUT]
    Name      http
    Match     gw
    Host      spend-meter.<your-subdomain>.workers.dev
    Port      443
    URI       /hooks/gateway/<gateway>?token=<WEBHOOK_TOKEN>
    Format    json
    compress  gzip
    tls       On
```

**Vector**
```toml
[sources.gw]
type = "file"
include = ["/var/log/gateway/access.log"]

[sinks.meter]
type = "http"
inputs = ["gw"]
uri = "https://<your-worker>/hooks/gateway/<gateway>?token=<WEBHOOK_TOKEN>"
encoding.codec = "json"
compression = "gzip"
```

On Kubernetes, run Fluent Bit as a DaemonSet with the same output, matching the gateway pods' container logs.

---

## Open-source and self-hosted

### Kong Gateway (`kong`)
Add the HTTP Log plugin globally. Kong batches requests for you.
```bash
curl -X POST http://localhost:8001/plugins \
  --data name=http-log \
  --data config.http_endpoint="https://<your-worker>/hooks/gateway/kong?token=<WEBHOOK_TOKEN>" \
  --data config.queue.max_batch_size=200 \
  --data config.queue.max_coalescing_delay=5
```
Kong versions before 3.3 use `config.queue_size` and `config.flush_timeout` instead of the `queue.*` settings. Each request is grouped by service name and attributed to the consumer's username.

### Apache APISIX (`apisix`)
Add the HTTP logger as a global rule:
```bash
curl http://127.0.0.1:9180/apisix/admin/global_rules/1 -H "X-API-KEY: $ADMIN_KEY" -X PUT -d '{
  "plugins": { "http-logger": {
    "uri": "https://<your-worker>/hooks/gateway/apisix?token=<WEBHOOK_TOKEN>",
    "batch_max_size": 200, "inactive_timeout": 5 } } }'
```

### Tyk (`tyk`)
1. Enable the stdout pump in `pump.conf`:
   ```json
   "pumps": { "stdout": { "type": "stdout", "meta": { "format": "json", "log_field_name": "tyk-analytics-record" } } }
   ```
2. Ship the pump's output with Fluent Bit or Vector.

The meter reads `api_name`, `path`, `response_code`, `alias` (consumer) and `request_time`.

### KrakenD (`krakend`)
Ship KrakenD's stdout with Fluent Bit or Vector. The meter reads its default `[GIN] … | 200 | 1.5ms | … | GET "/path"` access lines as they are.

### Traefik (`traefik`)
1. Write JSON access logs:
   ```yaml
   accessLog:
     filePath: /var/log/traefik/access.json
     format: json
     bufferingSize: 100
   ```
2. Ship the file.

`RouterName` becomes the API name, and `Duration` (in nanoseconds) is converted to milliseconds.

### Envoy Proxy (`envoy`)
1. Write the standard record as the access-log format:
   ```yaml
   access_log:
   - name: envoy.access_loggers.file
     typed_config:
       "@type": type.googleapis.com/envoy.extensions.access_loggers.file.v3.FileAccessLog
       path: /var/log/envoy/access.json
       log_format:
         json_format:
           ts: "%START_TIME%"
           api: "%ROUTE_NAME%"
           method: "%REQ(:METHOD)%"
           path: "%REQ(X-ENVOY-ORIGINAL-PATH?:PATH)%"
           status: "%RESPONSE_CODE%"
           latency_ms: "%DURATION%"
           bytes: "%BYTES_SENT%"
           consumer: "%REQ(X-CONSUMER-ID)%"
   ```
2. Ship the file.

Replace `X-CONSUMER-ID` with whatever header identifies your callers.

### Ocelot (`ocelot`)
Add a delegating handler that posts one record per request:
```csharp
public class MeterHandler : DelegatingHandler
{
    static readonly HttpClient Http = new();
    static readonly string Url = Environment.GetEnvironmentVariable("METER_URL")!;

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage req, CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        var res = await base.SendAsync(req, ct);
        var rec = new {
            api = req.RequestUri?.Host, method = req.Method.Method, path = req.RequestUri?.AbsolutePath,
            status = (int)res.StatusCode, latency_ms = sw.Elapsed.TotalMilliseconds,
            ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
        };
        _ = Http.PostAsJsonAsync(Url, rec); // fire and forget
        return res;
    }
}
// Program.cs
builder.Services.AddOcelot().AddDelegatingHandler<MeterHandler>(global: true);
```
Set `METER_URL` to your `/hooks/gateway/ocelot?token=…` URL.

### Express Gateway (`express-gateway`)
Add a small plugin policy and put `meter` first in each pipeline:
```js
// plugins/meter/manifest.js
module.exports = {
  version: '1.2.0',
  policies: ['meter'],
  init: (pluginContext) => pluginContext.registerPolicy({
    name: 'meter',
    policy: () => (req, res, next) => {
      const start = Date.now();
      res.on('finish', () => {
        fetch(process.env.METER_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api: req.egContext && req.egContext.apiEndpoint && req.egContext.apiEndpoint.apiEndpointName,
            method: req.method, path: req.path, status: res.statusCode,
            consumer: req.user && (req.user.username || req.user.id),
            latency_ms: Date.now() - start, ts: start
          })
        }).catch(() => {});
      });
      next();
    }
  })
};
```
This needs Node 18 or later for the built-in `fetch`.

### Zuul (`zuul`)
Add a post filter (Spring Cloud Netflix Zuul 1):
```java
@Component
public class MeterFilter extends ZuulFilter {
    private final RestTemplate http = new RestTemplate();
    private final String url = System.getenv("METER_URL");
    public String filterType() { return "post"; }
    public int filterOrder() { return 1000; }
    public boolean shouldFilter() { return true; }
    public Object run() {
        RequestContext ctx = RequestContext.getCurrentContext();
        HttpServletRequest req = ctx.getRequest();
        Map<String, Object> rec = Map.of(
            "api", String.valueOf(ctx.get("proxy")),   // Zuul route id
            "method", req.getMethod(),
            "path", req.getRequestURI(),
            "status", ctx.getResponseStatusCode(),
            "ts", System.currentTimeMillis());
        CompletableFuture.runAsync(() -> http.postForLocation(url, rec));
        return null;
    }
}
```

### Apiman (`apiman`)
Apiman stores metrics in Elasticsearch. Forward them with Logstash every 5 minutes. The windows are rounded to the minute so each request is sent exactly once.
```
input {
  elasticsearch {
    hosts => ["http://elasticsearch:9200"]
    index => "apiman_metrics"
    query => '{"query":{"range":{"requestStart":{"gte":"now-5m/m","lt":"now/m"}}}}'
    schedule => "*/5 * * * *"
  }
}
output {
  http {
    url => "https://<your-worker>/hooks/gateway/apiman?token=<WEBHOOK_TOKEN>"
    http_method => "post"
    format => "json_batch"
  }
}
```

---

## Cloud-managed

### Amazon API Gateway (`aws-api-gateway`)
1. **Stage → Logs → Access logging:** send to a CloudWatch log group with this format:
   ```json
   {"api":"$context.apiId","method":"$context.httpMethod","path":"$context.path","status":"$context.status","consumer":"$context.identity.apiKeyId","latency_ms":"$context.responseLatency","bytes":"$context.responseLength","ts":"$context.requestTimeEpoch"}
   ```
   HTTP APIs have no `identity.apiKeyId`. Drop that field or use an authorizer value instead.
2. Create an **Amazon Data Firehose** stream:
   - Source: Direct PUT
   - Destination: **HTTP endpoint**
   - Endpoint URL: `https://<your-worker>/hooks/gateway/aws-api-gateway`
   - Access key: your `WEBHOOK_TOKEN`
   - Content encoding: GZIP
3. On the log group, add a **subscription filter** that sends to that Firehose stream.

The meter unpacks the CloudWatch batches and answers Firehose in the format it expects.

### Azure API Management (`azure-apim`)
Add this to the policy at **All APIs** scope. Put the same block in `<on-error>` if you want failed calls counted too.
```xml
<outbound>
  <base />
  <send-one-way-request mode="new">
    <set-url>https://<your-worker>/hooks/gateway/azure-apim?token=<WEBHOOK_TOKEN></set-url>
    <set-method>POST</set-method>
    <set-header name="Content-Type" exists-action="override"><value>application/json</value></set-header>
    <set-body>@(new JObject(
        new JProperty("api", context.Api.Name),
        new JProperty("method", context.Request.Method),
        new JProperty("path", context.Request.Url.Path),
        new JProperty("status", context.Response.StatusCode),
        new JProperty("consumer", context.Subscription?.Name ?? ""),
        new JProperty("latency_ms", context.Elapsed.TotalMilliseconds),
        new JProperty("ts", DateTime.UtcNow.ToString("o"))
      ).ToString())</set-body>
  </send-one-way-request>
</outbound>
```
This posts once per request. For heavy traffic, read **Volume and limits** below.

### GCP API Gateway (`gcp-api-gateway`)
1. In **Logging → Log Router**, create a sink:
   - Destination: a new Pub/Sub topic
   - Filter: `resource.type="apigateway.googleapis.com/Gateway"`
2. In **Pub/Sub**, add a push subscription to that topic, with your gateway URL as the endpoint.

The meter reads `httpRequest` from each log entry.

### Google Apigee (`apigee`)
1. Add a MessageLogging policy in the proxy's PostClientFlow:
   ```xml
   <MessageLogging name="ML-Meter">
     <CloudLoggingConfiguration>
       <LogName>projects/{organization.name}/logs/apigee-meter</LogName>
       <Message contentType="application/json">{"api":"{apiproxy.name}","method":"{request.verb}","path":"{proxy.basepath}{proxy.pathsuffix}","status":{message.status.code},"consumer":"{developer.app.name}","ts":{system.timestamp}}</Message>
     </CloudLoggingConfiguration>
   </MessageLogging>
   ```
2. Create a Log Router sink with filter `logName="projects/<PROJECT>/logs/apigee-meter"` that sends to a Pub/Sub topic.
3. Add a push subscription to that topic, pointing at your Apigee gateway URL.

### Oracle API Gateway (`oracle-api-gateway`)
1. Enable **access logs** for the deployment in OCI Logging.
2. Create a **Connector Hub** connector:
   - Source: that log
   - Target: a **Notifications** topic
3. Add an **HTTPS (Custom URL)** subscription to the topic with your gateway URL.

The meter confirms the subscription automatically. For high volume, use a Functions target that batches records instead of Notifications.

### Zuplo (`zuplo`)
Add a final response hook in `modules/zuplo.runtime.ts`:
```ts
import { RuntimeExtensions, environment } from "@zuplo/runtime";

export function runtimeInit(runtime: RuntimeExtensions) {
  runtime.addResponseSendingFinalHook(async (response, request, context) => {
    context.waitUntil(fetch(environment.METER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api: context.route.path, method: request.method, path: new URL(request.url).pathname,
        status: response.status, consumer: request.user?.sub ?? "", ts: Date.now(),
      }),
    }));
  });
}
```
Add `METER_URL` as a Zuplo environment variable. If your Zuplo version names the hook differently, use its "response sending final" hook.

---

## Enterprise lifecycle

### MuleSoft Anypoint (`mulesoft`)
1. In API Manager, apply the **Message Logging** policy:
   - Logging level: After calling API
   - Category: `meter`
   - Message: `#[output application/json --- {api: app.name, method: attributes.method, path: attributes.requestPath, status: attributes.statusCode, ts: now()}]`
2. In the app's `log4j2.xml`, send that category to the meter:
   ```xml
   <Appenders>
     <Http name="Meter" url="https://<your-worker>/hooks/gateway/mulesoft?token=<WEBHOOK_TOKEN>">
       <PatternLayout pattern="%m%n"/>
     </Http>
   </Appenders>
   <Loggers>
     <!-- use the logger name your Message Logging lines show in the app log -->
     <AsyncLogger name="meter" level="INFO" additivity="false"><AppenderRef ref="Meter"/></AsyncLogger>
   </Loggers>
   ```

The meter pulls the JSON out of each log line.

### WSO2 API Platform (`wso2`)
1. Turn on ELK analytics in `deployment.toml`:
   ```toml
   [apim.analytics]
   enable = true
   type = "elk"
   ```
2. Ship `repository/logs/apim_metrics.log` with Fluent Bit or Vector.

The meter reads `apiName`, `apiResourceTemplate`, `proxyResponseCode`, `applicationName` and `responseLatency`.

### IBM API Connect (`ibm-api-connect`)
Use analytics offload to HTTP, in the analytics CR or `analytics_cr.yaml`:
```yaml
external:
  offload:
    enabled: true
    output: |
      http {
        url => "https://<your-worker>/hooks/gateway/ibm-api-connect?token=<WEBHOOK_TOKEN>"
        http_method => "post"
        codec => "json"
        content_type => "application/json"
        id => "offload_http"
      }
```
The meter reads `api_name`, `uri_path`, `status_code` (e.g. "200 OK"), `app_name` and `time_to_serve_request`.

### Boomi (`boomi`)
Boomi tracks process runs rather than HTTP traffic, so there's no request log to forward.

In each API-facing process, add a final **HTTP Client** connector step that POSTs the standard record to your Boomi gateway URL. Build the body with a Message shape from document properties such as method, path, status and app name.

### Layer7 (`layer7`)
Add a **message-completed** global policy fragment with two steps:
1. **Set Context Variable**, with a JSON body built from `${service.name}`, `${request.http.method}`, `${request.url.path}` and `${response.http.status}`.
2. **Route via HTTP(S)**, POSTing that body to your Layer7 gateway URL.

Alternatively, send the gateway's audit and traffic logs to syslog and forward them with Fluent Bit.

### Red Hat 3scale (`3scale`)
APIcast is NGINX, and its access log lines are read as they are, including `$request_time` at the end.
- **On VMs or containers:** ship APIcast's access log with Fluent Bit or Vector.
- **On OpenShift:** add a `ClusterLogForwarder` output of type `http` pointing at your 3scale gateway URL, filtered to the APIcast pods.

---

## Event-driven and federated

### Gravitee (`gravitee`)
1. Enable the file reporter in `gravitee.yml`:
   ```yaml
   reporters:
     file:
       enabled: true
       fileName: ${gravitee.home}/metrics/%s-%Y_%m_%d
       output: json
   ```
2. Ship only the `request-*` files, so health checks aren't counted as traffic.

### Axway Amplify Fusion (`axway`)
Fusion sits above other gateways, so connect the underlying gateways directly using their sections in this guide (AWS, Azure, Kong and so on). That gives per-request detail.

For integrations that run inside Fusion, add an HTTP POST step at the end of each flow sending the standard record to your Axway gateway URL.

### Kgateway / Gloo Gateway (`kgateway`)
Both run Envoy, so use the Envoy fields:
1. Configure access logging to stdout with a JSON format. In kgateway this goes in an `HTTPListenerPolicy` accessLog `fileSink` with `jsonFormat`; in Gloo, in a `ListenerOption`.
2. Use the same keys as the Envoy example above.
3. Ship the gateway pods' logs with a Fluent Bit DaemonSet.

---

## Volume and limits

Some setups post once per request: Azure APIM, Ocelot, Express Gateway, Zuul, Zuplo, Boomi and Layer7. Each request then costs one Worker call and a database write.

Cloudflare's free plan allows roughly 100,000 Worker requests and 100,000 database row writes a day. Above that you have three options:
- **Upgrade:** move to Workers Paid ($5 a month), or
- **Batch:** use Kong, APISIX, Firehose, Pub/Sub or a log shipper, which group many requests per post, or
- **Pre-aggregate:** send summary rows using `count`.

The meter checks budget thresholds hourly, so priced gateway traffic can take up to an hour to trigger an alert.
