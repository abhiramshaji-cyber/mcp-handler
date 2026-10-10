---
"mcp-handler": minor
---

Add experimental webhook endpoint verification, single-attempt MCP event delivery, and signed `gap`/`terminated` notice helpers with Standard Webhooks signing, connection-time address filtering with an explicit private-address allowlist, bounded requests, key rotation, and delivery authorization checks. Deliveries resolve to categorized results, including `Retry-After` hints and non-retryable policy rejections.
