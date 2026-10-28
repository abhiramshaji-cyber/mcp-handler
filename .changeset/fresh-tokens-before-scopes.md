---
"mcp-handler": patch
---

Return `401 invalid_token` for expired tokens before evaluating required scopes, including tokens at their expiration time. Document and test the existing scope challenges and retry flow for step-up authorization.
