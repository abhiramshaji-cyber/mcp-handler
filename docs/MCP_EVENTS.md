# MCP Events (experimental)

MCP Events lets an MCP client subscribe to things that happen in your system,
such as a new issue or a failed build, and have its agent react without the user
being present. `mcp-handler/events` implements the server side with **webhook
delivery**: the client subscribes on your existing MCP route, and your server
POSTs signed events to the client's callback URL.

It follows draft [SEP-3415](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3415)
and also speaks the earlier design-sketch dialect that
[ChatGPT implements](https://developers.openai.com/plugins/build/mcp-events),
detected per request (see [Protocol compatibility](#protocol-compatibility)).
Both the draft and this API are experimental and may change. Poll and push
delivery are not implemented; no client we target uses them.

You provide event definitions, a durable store and a queue. The engine handles
subscription storage, callback verification, fan-out, signing, retries, secret
rotation, expiry and revocation.

## Quickstart

### 1. Define events

```typescript
// lib/events.ts
import {
  defineEvent,
  createMcpEvents,
  redisStore,
  vercelQueue,
} from "mcp-handler/events";
import { createClient } from "redis";
import { send } from "@vercel/queue";
import { z } from "zod";
import { canReadProject } from "./permissions";

export const issueCreated = defineEvent({
  name: "issue.created",
  description: "A new issue is created in a project.",
  input: z.strictObject({ projectId: z.string() }),
  payload: z.object({
    id: z.string(),
    title: z.string(),
    projectId: z.string(),
  }),
  // Runs at subscribe time and again before every delivery.
  authorize: ({ projectId }, { principal }) =>
    canReadProject(principal, projectId),
  // Route each event only to subscriptions for the same project.
  partitionBy: {
    arguments: ({ projectId }) => projectId,
    payload: (issue) => issue.projectId,
  },
});
```

`input` describes the subscription arguments (filters) and `payload` the
delivered `data`. Use schemas that don't transform values: defaults, coercion
or stripping are rejected because arguments are part of subscription identity.
`partitionBy` is optional; without it every emit checks every subscription to
that event. Add `match(args, data)` to filter further within a partition.

### 2. Create the engine

```typescript
const redis = await createClient({ url: process.env.REDIS_URL }).connect();

export const events = createMcpEvents({
  events: [issueCreated],
  // A stable, issuer/tenant-scoped identity from your verified token.
  principal: (authInfo) => `${authInfo.extra?.iss}:${authInfo.extra?.sub}`,
  store: redisStore({ client: redis, prefix: "acme-mcp:" }),
  queue: vercelQueue({ topic: "mcp-events", send }),
});
```

### 3. Serve it from your MCP route

```typescript
// app/mcp/route.ts
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { events } from "@/lib/events";

const handler = createMcpHandler(registerTools, { events });

export const POST = withMcpAuth(handler, verifyToken, {
  required: true,
  resourceUrl: "https://mcp.example.com",
});
```

The `events` option adds `events/list`, `events/subscribe` and
`events/unsubscribe` to the same route as your tools. Events require an
authenticated principal; there is no anonymous mode.

### 4. Emit events

Call `emit` wherever changes arrive, for example an upstream webhook route:

```typescript
await events.emit(issueCreated, issue, {
  id: delivery.id, // stable for this occurrence; duplicates collapse
  occurredAt: new Date(issue.createdAt),
});
```

`emit` validates the data against the payload schema and queues one fan-out
job. It does not wait for deliveries.

### 5. Deliver from a queue consumer

```typescript
// app/api/mcp-events/route.ts
import { handleCallback } from "@vercel/queue";
import { vercelQueueConsumer } from "mcp-handler/events";
import { events } from "@/lib/events";

export const POST = vercelQueueConsumer(events, handleCallback);
```

```json
// vercel.json
{
  "functions": {
    "app/api/mcp-events/route.ts": {
      "experimentalTriggers": [
        { "type": "queue/v2beta", "topic": "mcp-events" }
      ]
    }
  }
}
```

## Running on Vercel

- **Store.** Any Redis 6.2 or later, for example a Redis database from the
  Vercel Marketplace. Pass a connected `redis` (node-redis) client. Use a
  distinct `prefix` per logical MCP server when servers share a database.
- **Queue.** Vercel Queues delivers each job to the consumer route registered
  in `vercel.json`. The engine controls retry timing; if you set
  `maxDeliveries` on the trigger, keep it at or above `maxDeliveryAttempts`.
  Give the consumer a `maxDuration` above the webhook timeout (10 seconds by
  default). Messages are pinned to the deployment that published them, so
  retries after a deploy run the old code until they finish.
- **Runtime.** `mcp-handler/events` uses Node.js built-ins; run the MCP route
  and the consumer on the Node.js runtime. The root `mcp-handler` entry stays
  free of them.
- **Auth.** Use OAuth with `withMcpAuth(..., { required: true })` and set
  `resourceUrl` to your stable public origin, never a per-deployment URL.
  ChatGPT requests only the OAuth scopes your tools declare, so make sure the
  scopes `events/*` requires are among them.
- **Deployment Protection and Firewall.** Clients must reach `/mcp` without
  Vercel authentication: use a production domain (Standard Protection leaves
  it public) or a Deployment Protection Exception. Bot Protection challenges
  and the AI Bots ruleset can block MCP clients; start them in Log mode.

For local development, `memoryStore()` and `memoryQueue()` keep everything in
one process (`memoryQueue({ mode: "manual" })` waits for `drain()`, which suits
tests). Neither survives a restart or works across serverless instances.

## Protocol compatibility

|                      | SEP-3415 clients                                                                                                                      | ChatGPT compat                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Detected by          | The request declares `extensions["io.modelcontextprotocol/events"]` in its per-request client capabilities                            | Everything else, including all pre-`2026-07-28` requests |
| Capability           | `capabilities.extensions["io.modelcontextprotocol/events"]`                                                                           | top-level `capabilities.events`                          |
| Error codes          | NotFound `-32023`, Forbidden `-32024`, ResourceExhausted `-32025`, Unsupported `-32026`, CallbackEndpointError `-32027` (provisional) | `-32011` … `-32015` in the same order                    |
| `terminated` notices | Sent on revocation and incompatible schema changes                                                                                    | Not sent (unsupported by ChatGPT)                        |

The server always advertises both capability shapes. Each subscription
remembers the dialect of the client that created or last refreshed it, so
background deliveries know whether `terminated` notices are allowed. Webhook
payloads, headers and signatures are identical in both. Set
`chatgptCompat: false` to serve SEP-3415 only.

## How subscriptions and delivery work

**Subscribe.** The engine authenticates the caller, validates and authorizes
the arguments, reserves the subscription, verifies the callback, then commits
the grant. Verification sends a signed challenge the endpoint must echo. A
successful challenge is cached per (principal, URL) for `consentTtlMs`, so
refreshes and new filters for the same callback skip it. Verification attempts
are limited per principal and host and per host overall, and each principal
has at most `subscriptionsPerPrincipal` subscriptions. If an unsubscribe
arrives while a challenge is outstanding, the late result cannot activate the
subscription.

**Lifetime.** Grants last `ttl.defaultMs` (1 hour) unless the client asks for
less, clamped to `ttl.minMs` and `ttl.maxMs`. Clients refresh by subscribing
again before `refreshBefore`; a refresh with a new secret keeps signing with
the old one too for `secretRotationGraceMs`. ChatGPT sends no `ttlMs`, so the
default sets its refresh cadence, and removing a plugin sends no unsubscribe:
expiry cleans up.

**Emit and fan-out.** `emit` queues one fan-out job, which pages through the
subscriptions in the event's partition, applies `match`, and queues one
delivery per subscription. Repeated emits with the same `id` and repeated
fan-out runs produce one delivery per subscription.

**Delivery.** Each delivery reloads the subscription, re-runs `authorize` and
checks expiry, then POSTs `{ eventId, name, timestamp, data, cursor }` with
Standard Webhooks headers and `X-MCP-Subscription-Id`. A `2xx` status
acknowledges it. Other failures are retried up to `maxDeliveryAttempts` (5)
using the endpoint's `Retry-After` or 30 s, 1 min, 3 min and 8 min. `410`,
`413`, redirects and blocked destinations are not retried. Results feed the
`deliveryStatus` returned on the next refresh.

**Revocation.** When `authorize` stops returning `true`, the subscription is
removed. SEP-3415 clients receive a `terminated` notice; ChatGPT learns on its
next refresh, which returns Forbidden. A policy service outage is not treated
as revocation: the delivery is retried. If a deployment changes an event's
input schema so stored arguments no longer validate, those subscriptions end
the same way with `Unsupported`.

**No replay.** Deliveries carry `cursor: null`, so clients resubscribe from
"now". A subscribe that asks to resume from a cursor gets `truncated: true`.

Callbacks must be HTTPS to a public address checked at connection time;
redirects are never followed. See [Network options](#network-options) to
allow private receivers.

## Configuration

| Option                       | Default             | Meaning                                                                |
| ---------------------------- | ------------------- | ---------------------------------------------------------------------- |
| `events`                     | required            | Definitions from `defineEvent`, with unique names                      |
| `principal(authInfo)`        | required            | Stable identity from verified auth. Never the OAuth client ID          |
| `store`, `queue`             | required            | See [Storage and queues](#storage-and-queues)                          |
| `ttl`                        | 1 min / 1 h / 1 day | `{ minMs, defaultMs, maxMs, allowNoExpiry }`                           |
| `chatgptCompat`              | `true`              | Serve the ChatGPT dialect to clients that don't declare SEP-3415       |
| `network`                    | —                   | `{ allowIPAddressList, timeoutMs }` for verification and delivery      |
| `maxDeliveryAttempts`        | `5`                 | Attempts per event and subscription                                    |
| `subscriptionsPerPrincipal`  | `100`               | Active and pending subscriptions per principal                         |
| `verificationsPerMinute`     | `10`                | Challenges per principal and callback host                             |
| `hostVerificationsPerMinute` | `600`               | Challenges per callback host across principals (ChatGPT uses one host) |
| `consentTtlMs`               | 1 day               | How long a verified (principal, URL) skips the challenge               |
| `secretRotationGraceMs`      | 10 min              | How long deliveries stay signed with a replaced secret                 |
| `onError(error, job)`        | —                   | Unexpected errors while processing jobs                                |

## Storage and queues

**Stores** implement `McpEventsStore`: per-key compare-and-set, expiry,
counters and set indexes, all on opaque strings. The engine builds every
invariant on top. `runEventsStoreConformance(store)` checks an implementation
(it resolves or throws, so it works in any test runner).

- `redisStore({ client, prefix })` needs only node-redis's
  `eval(script, { keys, arguments })`. Every operation is a single-key Lua
  script, so it is atomic and works on clusters. Other clients work through an
  object with that method, for example
  `{ eval: (script, { keys, arguments: args }) => ioredis.eval(script, keys.length, ...keys, ...args) }`.
- `memoryStore()` for development and tests.

**Queues** implement `McpEventsQueue`: an at-least-once `send(job,
{ idempotencyKey, delayMs })`. Their consumer passes each job to
`events.process(job, { attempt })` and retries after `retryAfterMs` when the
result has one. `vercelQueue` / `vercelQueueConsumer` do this for Vercel
Queues; `memoryQueue()` does it in-process.

## Testing with ChatGPT

ChatGPT supports MCP Events in Work chats on chatgpt.com, desktop Work chats
with Cloud selected, and dots
([OpenAI docs](https://developers.openai.com/plugins/build/mcp-events)). Field
reports so far succeed fastest with a personal Plus or Pro account and a
personal plugin in a Work chat on the web; managed workspaces need admin
permissions for custom MCP servers and event-triggered tasks.

1. Deploy to a public production domain and confirm an unauthenticated request
   to `/mcp` returns your app's `401` with `WWW-Authenticate`, not a Vercel
   login page.
2. In ChatGPT, add a custom MCP server (chatgpt.com/plugins), choose **OAuth**
   (not "OAuth or no authentication", since events require a principal), and
   install the plugin.
3. Check your logs for `server/discover` and `events/list`; the events appear
   next to the tools on the plugin page. Refresh the plugin after every server
   change.
4. In a Work chat, ask ChatGPT to watch something. Expect `events/subscribe`
   with a `whsec_` secret and a callback on `connectors.api.openai.com`, then a
   verification POST that ChatGPT answers with the echoed challenge.
5. Emit a matching event and confirm a `2xx` delivery and a reply in the chat.
   Emit a non-matching one and confirm nothing is sent.
6. Stop monitoring (delete the task under Scheduled) and confirm
   `events/unsubscribe`. Then test refresh across a redeploy, revoked access,
   duplicate events and bursts (ChatGPT may batch them).

Before involving ChatGPT, point a subscription at a receiver you control that
echoes challenges and checks signatures with a Standard Webhooks library. For a
receiver on a private address, allow it with `network.allowIPAddressList` (in
test configuration only) and serve a certificate Node.js trusts.

## Advanced: bring your own infrastructure

`createMcpEvents` is built from lower-level pieces exported by
`mcp-handler/events/advanced`, for applications with their own storage,
queueing or delivery. With them you implement the subscription and delivery
adapters described below yourself:

```typescript
import { createMcpHandler } from "mcp-handler";
import { registerMcpEvents } from "mcp-handler/events/advanced";
import {
  issueCreated,
  subscriptionStore,
  webhookDelivery,
} from "./events-backend";

const handler = createMcpHandler((server) => {
  registerMcpEvents(server, {
    events: [issueCreated],
    getPrincipal: (authInfo) => principalFromVerifiedAuth(authInfo),
    subscriptions: subscriptionStore,
    delivery: webhookDelivery,
  });
});
```

The root `mcp-handler` entry keeps the 2.3.0 exports
(`experimental_registerMcpEvents`, `experimental_validateMcpEventDelivery` and
their `Experimental*` types) and has no Node.js-only dependencies.

### Methods and capabilities

The existing MCP endpoint advertises both capability shapes (see
[Protocol compatibility](#protocol-compatibility)) and serves:

| Method               | Behavior                                                                                                                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `events/list`        | Returns the authenticated account's catalog with `delivery: ["webhook"]`, input schemas and payload schemas.                                                                                       |
| `events/subscribe`   | Validates and authorizes arguments, derives subscription identity, reserves a fenced operation, verifies callback consent, and delegates conditional creation/refresh to the subscription adapter. |
| `events/unsubscribe` | Resolves the same principal/callback/event/arguments key and delegates cancellation.                                                                                                               |

All methods use the same `/mcp` route (or whichever route hosts the handler).
There is no extra inbound event route on this server: webhook delivery is an
outbound operation to the client's callback. Poll and push are not advertised
or implemented. The helper does not add anything to `tools/list`; a client that
wants model-callable subscription tools must build those from `events/list`.

The `@modelcontextprotocol/client` 2.0 capability parser drops the top-level
`events` field from `getServerCapabilities()` but keeps
`extensions["io.modelcontextprotocol/events"]`, so SDK-based clients can detect
the extension from the SEP-3415 shape.

The catalog is returned as a single page, without `nextCursor`. Requests with a
catalog cursor are rejected. For account-specific discovery, supply a resolver:

```typescript
events: async (context) => {
  return await catalogForPrincipal(context.principal);
},
```

The resolver runs within each authenticated request. An event can additionally
provide `authorizeDiscovery(context)` to hide its definition from callers who
cannot subscribe to that event type. This optional policy receives the verified
request context (`principal`, `authInfo`, `signal`) and must explicitly return
`true` to expose the event. It runs for both static arrays and resolved catalogs,
on every list and subscribe request. A hidden name cannot bypass the policy by
being supplied directly to `events/subscribe`; it returns `NotFound` before
filter authorization, reservation or callback verification. Policy exceptions
fail the request through the normal safe error handling. Omit the hook when the
catalog resolver already determines visibility or all callers may discover it.

Discovery has no event arguments, so the helper does not call `authorize` with
empty or invented filters. Each event's required `authorize(arguments, context)`
separately checks the actual requested filters before verification or storage
changes. For example, `authorizeDiscovery` can check whether the caller has any
readable projects, while `authorize` checks access to the specific `project_id`.
Visibility does not grant permission to every set of filters. Unsubscribe stays
available when discovery permission is removed so existing subscriptions can
still be stopped.

The filter policy receives `{ principal, signal }` so it can also run in a
delivery worker without request credentials. The catalog and adapter callbacks
still receive request `authInfo`. Use non-transforming Standard Schemas:
defaults, stripping fields, coercion or other argument transformations are
rejected when they change the input, because arguments are part of identity.

### Principal and subscription identity

`getPrincipal` receives the verified `AuthInfo` provided by `withMcpAuth`. Return
a stable, tenant/issuer-scoped user or app identifier. For example, derive it from
the issuer, tenant and subject established by your token verifier. Do not derive
it from event arguments or use the OAuth `clientId` as an end-user identity; many
users can share one OAuth client. The helper rejects missing/expired auth and
empty principals, and requires authentication for catalog discovery too.

This helper has no anonymous mode. Public demo feeds can be useful, but a
callback challenge only proves control of the receiving endpoint; it does not
establish permission to read another user's events. Do not manufacture an
`AuthInfo` or accept a user ID from event arguments to bypass authentication.
For a ChatGPT connection to private data, use OAuth and enforce the event's
`authorize` policy both at subscription time and in delivery workers.

The server derives `sub_<sha256>` from the canonical JSON tuple
`[principal, delivery.url, name, arguments]`. Object key order does not affect
identity. The callback URL is used as supplied, after validation. Changing any
identity component creates a different subscription. Changing the secret,
requested TTL or replay cursor refreshes the same key. Subscription IDs are
routing handles, never authorization grants. Namespace a shared storage adapter
per logical MCP server so unrelated servers cannot mix their subscriptions.

Unsubscribe accepts `name`, `arguments` and `delivery.url`, not a subscription
ID. It remains available when an event disappears or its schema changes: cleanup
uses the saved identity, not the current catalog. A missing subscription returns
NotFound (`-32023`, or `-32011` in ChatGPT compat) with
`data.kind: "subscription"`.

### Adapter contracts

The exported types describe the required methods:

| Adapter                | Method                                       | Required behavior                                                                                                                                                                                                                   |
| ---------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `McpWebhookDelivery`   | `verifyEndpoint(target, context)`            | Prove callback consent before activation. Return `{ verified: true }` only after a signed challenge succeeds or another verification mechanism allowed by the draft establishes consent; otherwise return a categorized failure.    |
| `McpSubscriptionStore` | `prepare(key, context)`                      | Reserve a bounded, durable operation and return its unique fencing token. Apply admission limits before verification. Preserve any current active grant.                                                                            |
| `McpSubscriptionStore` | `upsert(subscription, context, operationId)` | Atomically require the current, unexpired operation token before persisting/refreshing the verified subscription and arranging activation/reconciliation. Return `{ cursor, truncated, deliveryStatus? }` from the delivery system. |
| `McpSubscriptionStore` | `remove(key, context)`                       | Atomically invalidate pending operations, stop delivery and arrange cleanup. Return true for a grant or pending reservation; false if neither exists.                                                                               |

These can be two interfaces to the same durable backend. The store is a lifecycle
adapter, not just a raw key/value database client: `upsert` must not commit a row
and then launch an untracked asynchronous delivery task. Use a transactional
outbox or equivalent recovery mechanism. Both create/refresh and cancellation
must be atomic and idempotent under concurrent requests and backend retries.
Requests can fail after a commit; a retry must converge on the same subscription.

The application backend is responsible for:

- Endpoint consent cached per `(principal, url)`, failed-verification rate limits,
  and egress policy enforcement on every verification and delivery attempt,
  including DNS resolution. Do not follow redirects; bound timeouts and response
  sizes. Registration only validates HTTPS URL syntax; the optional webhook
  helpers also enforce these network protections when making requests.
- Standard Webhooks signing using a vetted implementation. Event deliveries need
  `webhook-id`, `webhook-timestamp`, `webhook-signature` and
  `X-MCP-Subscription-Id`. Re-sign each retry with a fresh timestamp; support
  in-flight secret rotation and signed verification/gap/termination controls.
  The optional webhook helpers implement this signing.
- Event sources, filter matching, payload-schema validation and ongoing
  authorization. Admission authorization alone does not authorize delivery after
  access is revoked. Enforce quotas, expiry and cancellation in the worker.
- Durable, bounded retries and acknowledgement handling. Stop retrying an event
  on `410` or `413` without deleting its subscription. Keep cancelled delivery
  work from becoming active after a delayed create/refresh.
- Safe replay watermarks and gap reporting. `upsert` receives the requested
  `cursor` (missing becomes null) and `maxAgeMs`. Return a safe watermark that
  does not run ahead of unacknowledged events. For a live source without replay,
  return `cursor: null`. Return `truncated: true` when resumption skipped events.
- Secret protection at rest and redaction in backend logs. Adapter exceptions
  and invalid return values become a generic protocol error. Explicit
  `ProtocolError`s with the draft's codes retain their code and only fixed,
  allowlisted diagnostic categories; endpoint response content is never returned.

Adapters receive the verified auth context and an abort signal. Do not retain
access tokens in subscription records or log them. Storage and delivery must
outlive the HTTP handler: `createMcpHandler` creates a fresh `McpServer` per
request, so a Map or timer inside its initializer cannot maintain subscriptions.
Only consent established by the verifier is passed into `upsert`. A `prepare`
reservation does not activate delivery or change a current grant's secret or
expiry. It may record pending operation metadata before verification.

#### Coordinating verification with cancellation

The call order is `prepare → verifyEndpoint → upsert`. The helper passes the
opaque token returned by `prepare` as `upsert`'s third argument. The token stays
inside the server and is never returned to the MCP client. Storage implements
these steps using short transactions:

1. `prepare` assigns a unique operation token to the subscription key and a
   bounded reservation deadline. A newer operation supersedes the previous one.
   Existing active delivery continues under its previously verified grant.
2. `verifyEndpoint` performs network verification outside the transaction.
3. `upsert` checks the token and reservation deadline in the same transaction
   that commits the verified grant. A mismatched or expired token fails without
   changing the subscription or activating delivery. Repeating a committed
   operation must converge without replaying an older grant over newer state.
4. `remove` invalidates the reservation and stops the grant atomically. Pending
   reservations count as existing subscriptions for cancellation, even when
   verification has not finished.

For example, if unsubscribe completes while a callback challenge is outstanding,
its response may still arrive successfully. The subsequent `upsert` must reject
that operation. The same check prevents an older refresh from overwriting a
newer secret or deadline. Do not hold a database transaction across HTTP calls.

The backend must reclaim reservations after failed verification, request aborts,
and process crashes. Use bounded deadlines and a durable cleanup worker; the
helper does not promise a cleanup callback after a process crash. Reclaiming a
reservation must preserve any active grant and must never make its old token
valid again. `upsert` must not interpret a missing reservation as permission to
insert. Backend exceptions remain generic protocol errors, without leaking
operation tokens or endpoint responses.

The tests demonstrate this ordering with an in-memory adapter fixture. Real
adapters need database-backed fencing and their own concurrency/recovery tests.

#### Migrating an existing server

Preserve the server-selected principal and callback URL representation used by
existing subscriptions. This helper hashes the supplied URL verbatim; a backend
that previously normalized URLs must reconcile existing keys before migration.
Keep no-expiry behavior explicit with `ttl.allowNoExpiry`, and reject unsupported
replay cursors in the backend instead of returning a false success. Applications
without replay should continue returning `cursor: null`.

### Optional webhook helpers

Three experimental Node.js helpers cover the signed challenge exchange, a single
event delivery attempt, and `gap`/`terminated` notices. They use
`standardwebhooks` for signatures and `request-filtering-agent` for address
checks at connection time. All of them require HTTPS, reject credentials and URL
fragments, reject private/special-use addresses unless explicitly allowed,
preserve TLS certificate verification, and never follow redirects. These
restrictions also apply in development. There is no custom `fetch` or agent
override; applications with a different egress policy (for example, a mandatory
outbound proxy) can keep their own `McpWebhookDelivery`
implementation.

#### Network options

Every helper accepts the same optional settings: the third argument of
`verifyWebhookEndpoint`, or `network` for the other two.

```typescript
import type { WebhookNetworkOptions } from "mcp-handler/events/advanced";

export const webhookNetwork: WebhookNetworkOptions = {
  // Private receivers you operate. Every other non-public address stays blocked.
  allowIPAddressList: ["10.20.0.0/16"],
  timeoutMs: 5_000,
};
```

| Option               | Meaning                                                                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `allowIPAddressList` | IP addresses or CIDRs that may be reached even though they are private or special-use. Hostnames are rejected. Default `[]`.              |
| `timeoutMs`          | Total deadline for each request, including DNS, TLS and (for challenges) the response body. Default `10000`; the draft calls ~5 s common. |

Use one settings object for all helpers, and never derive the allowlist from
client input. To test end to end against a local receiver, allow `127.0.0.1` in
test configuration only and serve HTTPS with a certificate Node.js trusts, for
example through `NODE_EXTRA_CA_CERTS`.

#### Verify callback consent

`verifyWebhookEndpoint(target, context, network?)` can be used
directly as `verifyEndpoint`. It sends one signed verification challenge and
returns `{ verified: true }` only when a complete `2xx` JSON response echoes the
nonce. Mismatches and transport failures return `{ verified: false, reason }`
with the draft's diagnostic categories; blocked destinations are reported as
`connection_refused`. It never returns endpoint content. Invalid targets or
network options throw a `TypeError`.

Wrap it in your application's consent cache and admission controls:

```typescript
import {
  verifyWebhookEndpoint,
  type McpWebhookDelivery,
} from "mcp-handler/events/advanced";
import {
  consentStore,
  verificationLimiter,
  webhookNetwork,
} from "./events-backend";

export const webhookDelivery: McpWebhookDelivery = {
  async verifyEndpoint(target, context) {
    // Scope this store to this logical MCP server; isVerified checks expiry.
    const key = { principal: context.principal, url: target.url };
    if (await consentStore.isVerified(key)) return { verified: true };

    // Bound attempts per destination host, including failed challenges.
    await verificationLimiter.check(new URL(target.url).hostname);
    const result = await verifyWebhookEndpoint(target, context, webhookNetwork);
    if (result.verified) await consentStore.markVerified(key);
    return result;
  },
};
```

`consentStore` and `verificationLimiter` are application APIs. The helper has no
process-global consent cache: verification for one principal or logical MCP
server must not authorize another. Cache consent per `(principal, exact URL)`
with a bounded lifetime, coalesce concurrent checks, and retain verified status
with durable no-expiry subscriptions. Keep the existing `prepare → verifyEndpoint
→ upsert` ordering; a successful challenge alone does not activate delivery or
make a stale reservation valid.

#### Send one event

`deliverWebhookEvent` invokes `validateEventDelivery`
first, then signs and sends the event. Use it from a durable worker after loading
current active state and matching the source event to the subscription filters:

```typescript
import {
  deliverWebhookEvent,
  sendWebhookControl,
} from "mcp-handler/events/advanced";
import {
  issueCreated,
  subscriptionStore,
  webhookNetwork,
} from "./events-backend";

async function attemptDelivery(job) {
  const subscription = await subscriptionStore.get(job.subscriptionId);
  if (!subscription) return { done: true };

  // The worker owns filter matching and coordination with cancellation.
  const result = await deliverWebhookEvent({
    event: issueCreated,
    subscription,
    payload: job.payload,
    eventId: job.eventId,
    timestamp: new Date(job.occurredAt),
    cursor: job.safeWatermark,
    previousSecrets: await subscriptionStore.getPreviousSecrets(
      subscription.id,
    ),
    network: webhookNetwork,
    signal: job.signal,
  });
  if (result.ok) return { done: true };

  if (result.reason === "forbidden") {
    // Access was revoked: notify the receiver, then remove the subscription.
    await sendWebhookControl({
      subscription,
      control: {
        type: "terminated",
        error: { code: -32024, message: "Forbidden" },
      },
      network: webhookNetwork,
    });
    await subscriptionStore.terminate(subscription.id);
  }

  // Return to the durable queue's bounded retry/acknowledgement policy.
  return result.retryable
    ? { retry: true, delayMs: result.retryAfterMs }
    : { done: true, abandoned: result.reason };
}
```

| Input                              | Meaning                                                                                                                                                                                       |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `event`, `subscription`, `payload` | Trusted definition, freshly loaded active subscription, and matching source data. The helper checks the current permission policy, both schemas, event name and expiry.                       |
| `eventId`                          | Stable event identifier, reused across retries; also sent as `webhook-id`.                                                                                                                    |
| `timestamp`                        | Required `Date` when the event occurred. Persist it with the job and preserve it across retries.                                                                                              |
| `cursor`                           | Optional safe acknowledged/abandoned watermark, default `null`. The subscription's requested replay cursor is not an input.                                                                   |
| `previousSecrets`                  | Up to two additional trusted secrets for a short rotation grace period. Each attempt signs with the subscription's current secret plus these keys. Load current rotation state on each retry. |
| `network`                          | Optional [network options](#network-options).                                                                                                                                                 |
| `signal`                           | Optional worker cancellation signal. Cancellation rejects with the caller's abort reason and destroys the request.                                                                            |

The request body is `{ eventId, name, timestamp, data, cursor }`. Every attempt
gets fresh Standard Webhooks signing headers and `X-MCP-Subscription-Id`. The
helper snapshots the selected subscription fields and plain JSON payload before
async validation; unrelated database metadata is ignored. Payload key order is
preserved, and object properties set to `undefined` are omitted, as with
`JSON.stringify`. Unpadded valid `whsec_` secrets are accepted, as in
subscription registration.

A `2xx` status acknowledges the event. The helper resolves as soon as response
headers arrive and discards the body, so a large, slow or truncated response body
cannot turn an accepted event into a failure or a duplicate.

Every known outcome resolves, so a worker can handle the result with one
`switch`. A failure is `{ ok: false, reason, retryable }`, with no endpoint
response content:

| `reason`                                     | `retryable`             | Meaning                                                                                                                                       |
| -------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `connection_refused`, `timeout`, `tls_error` | yes                     | No response, including DNS failures and connections dropped before response headers.                                                          |
| `http_4xx`, `http_5xx`                       | yes, except `410`/`413` | Includes `status`, and `retryAfterMs` when a retryable response has a valid `Retry-After`. `410`/`413` stop this event, not the subscription. |
| `redirect`                                   | no                      | A `3xx` response. Redirects are never followed.                                                                                               |
| `blocked_destination`                        | no                      | The URL resolved to an address that is not publicly routable and not in `allowIPAddressList`.                                                 |
| `expired`                                    | no                      | The grant expired, including during asynchronous checks or right before sending.                                                              |
| `forbidden`                                  | no                      | The policy no longer allows delivery. The draft expects a `terminated` notice.                                                                |
| `invalid_subscription`                       | no                      | Unusable stored record: identity shape, deadline, callback URL, subscription ID or signing key.                                               |
| `invalid_arguments`, `event_mismatch`        | no                      | Stored filters no longer match the input schema unchanged, or the definition belongs to another event.                                        |
| `invalid_payload`, `payload_too_large`       | no                      | The data is not plain JSON matching the payload schema unchanged, or the envelope exceeds 256 KiB. Size is checked before any policy call.    |

Nothing is sent for the rejections from `expired` down. The helper throws only
in three cases: a `TypeError` for malformed arguments (an `eventId` that is not
a header-safe string, an invalid timestamp or cursor, more than two previous
secrets, invalid network options); exceptions from the event's schemas or
`authorize` policy, which should be retried because a policy-service outage is
not revoked access; and caller cancellation. The helper does not schedule
retries, update acknowledgement state, compute watermarks, cache permissions, or
delete subscriptions.

#### Send gap and termination notices

`sendWebhookControl({ subscription, control, previousSecrets?,
network?, signal? })` signs and sends one of the draft's non-event bodies, with
the same headers and transport rules as events:

```typescript
await sendWebhookControl({
  subscription,
  control: { type: "gap", cursor: freshCursor },
  network: webhookNetwork,
});
```

| `control`                                                 | Body sent                                                |
| --------------------------------------------------------- | -------------------------------------------------------- |
| `{ type: "gap", cursor }`                                 | `{"type":"gap","cursor":"…"}`                            |
| `{ type: "terminated", error: { code, message, data? } }` | `{"type":"terminated","error":{"code":…,"message":"…"}}` |

Only these fields are sent, and `data` must be plain JSON. No authorization or
expiry checks run, because `terminated` is often sent precisely because access
was revoked. The `webhook-id` is `msg_<type>_<digest>`, derived from the
subscription ID and body, so retries of the same notice reuse it and receivers
can deduplicate them. Results use the same shape as event delivery; the only
possible rejections are `invalid_subscription` and `payload_too_large`.
Malformed notices throw a `TypeError`. The worker decides when a gap occurred,
retries notices, and removes terminated subscriptions through its storage
adapter.

All helpers use the configured total request deadline (ten seconds by default).
Challenge responses are limited to 64 KiB and outgoing bodies to 256 KiB. DNS
address checks apply on each attempt, with no pooled connections. Timeouts,
aborts, truncated responses and oversized challenge responses tear down the
request. The validation-only helper below remains useful when your backend
already provides signing and delivery.

### Validating delivery in a worker

Export the same event definition for your MCP handler and durable worker. Before
each delivery attempt, load the current active subscription and validate the
candidate data:

```typescript
import { validateEventDelivery } from "mcp-handler/events/advanced";
import {
  issueCreated,
  subscriptionStore,
  durableWebhookDelivery,
} from "./events-backend";

async function deliverIssue(subscriptionId: string, payload: unknown) {
  // Application-specific get(): return only current, active subscriptions.
  const subscription = await subscriptionStore.get(subscriptionId);
  if (!subscription) return;

  await validateEventDelivery({
    event: issueCreated,
    subscription,
    payload,
  });

  // The durable backend gates dispatch against cancellation, then signs/sends.
  await durableWebhookDelivery.send({ subscription, payload });
}
```

`get()` and `send()` above are application APIs, not new required adapter methods.
The helper returns `Promise<void>` and throws on failure. It checks the event
name, a nonempty stored principal, and the granted `refreshBefore`; `null` permits
no expiry, while missing or malformed deadlines fail closed. It validates the
stored arguments and `payload` (the event's `data`, not the webhook envelope)
against the current schemas, then invokes `event.authorize(arguments, {
principal, signal })`. It rechecks expiry and an optional caller-provided `signal`
after asynchronous validation and authorization. It does not transform data:
coercion, stripping, defaults or mutation that change the JSON value are rejected
so the worker can send the original validated payload. Use plain JSON values.

The helper needs only `principal`, `name`, `arguments` and `refreshBefore` from
the stored record; it does not need the original access token or signing secret.
`authorize` must consult current application permissions and any durable grant
restrictions maintained by your backend. Access-token expiry and subscription
expiry are separate; a user does not need to stay logged in. The draft recommends
periodic permission rechecks; it does not mandate token verification for every
event. This helper invokes the policy on each call and does not cache its result.

Known failures throw `EventDeliveryError` with a fixed message and
one of these `code` values:

| Code                   | Meaning                                                                  |
| ---------------------- | ------------------------------------------------------------------------ |
| `invalid_subscription` | Missing record, invalid identity/arguments shape, or malformed deadline. |
| `event_mismatch`       | The supplied definition belongs to another event name.                   |
| `expired`              | The stored grant expired, including during an asynchronous check.        |
| `invalid_arguments`    | Stored filters no longer match the current input schema unchanged.       |
| `invalid_payload`      | Candidate data is not JSON matching the payload schema unchanged.        |
| `forbidden`            | The authorization policy did not explicitly allow delivery.              |

Do not send on any failure. Policy/schema exceptions and abort reasons propagate
unchanged: a permissions-service outage is not proof of revocation. Let the
durable worker decide retries and termination; this helper does not delete
subscriptions or send signed termination controls (see
[`sendWebhookControl`](#send-gap-and-termination-notices)).

This validates a candidate against the supplied state, not against the database.
It cannot detect a cancelled or suspended subscription in an old snapshot.
The backend must coordinate active state, expiry, cancellation and dispatch,
including on retries and after queue delays. It also owns matching source events
to the subscription's filters: schema validation alone cannot prove that an
issue belongs to an authorized project. Keep definitions and subscription
records trusted, and do not mutate validated values before sending. The helper
does not sign or verify webhook signatures, make network requests, or schedule
work.

### TTL and refresh

By default, the server grants one hour, clamps requests to a one-minute minimum
and one-day maximum, and does not grant no-expiry subscriptions. Configure this
with `ttl: { minMs, defaultMs, maxMs, allowNoExpiry }`.

An explicit `ttlMs: null` requests no expiry. The helper grants it only when
`allowNoExpiry: true`; otherwise it grants the default finite TTL. Omitted TTLs
and finite requests always receive finite grants, even when no expiry is enabled.
Only enable no expiry when the backend persists subscriptions across restarts
and provides sustained-failure cleanup. Storage must honor every granted expiry.

The client renews a finite subscription by re-calling `events/subscribe` with the
same identity before `refreshBefore`. The adapter updates expiry and secret,
reactivates suspended delivery, and returns its latest cursor/status. No-expiry
clients should still occasionally refresh for health checks and cursor progress.
Webhook mode does not need push heartbeat notifications or a held-open connection.

### Request telemetry

`onEvent` continues to report requests, but telemetry for every `events/*`
method replaces a supplied `params.delivery.secret` with `[REDACTED]`, including
unknown methods and servers where the extension is not registered. This also
protects callers that reuse subscribe parameters when unsubscribing. The actual
protocol request still receives the original secret.
Application logging outside this hook needs equivalent redaction.
