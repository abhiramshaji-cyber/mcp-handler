import { Redis } from "@upstash/redis";
import { send } from "@vercel/queue";
import {
  createMcpEvents,
  defineEvent,
  fromUpstash,
  redisStore,
  vercelQueue,
} from "mcp-handler/events";
import { z } from "zod";

// TODO: Replace with your application's permission check.
async function canReadProject(principal: string, projectId: string) {
  return principal.length > 0 && projectId.length > 0;
}

// Shared by the MCP route, the upstream webhook route and the queue consumer.
export const issueCreated = defineEvent({
  name: "issue.created",
  description: "A new issue is created in a project.",
  input: z.strictObject({
    projectId: z.string().describe("The project to watch"),
  }),
  payload: z.object({
    id: z.string(),
    title: z.string(),
    projectId: z.string(),
  }),
  authorize: ({ projectId }, { principal }) =>
    canReadProject(principal, projectId),
  partitionBy: {
    arguments: ({ projectId }) => projectId,
    payload: (issue) => issue.projectId,
  },
});

export const events = createMcpEvents({
  events: [issueCreated],
  // Scope identities by issuer so users from different tenants never collide.
  principal: (authInfo) =>
    `${String(authInfo.extra?.issuer)}:${String(authInfo.extra?.userId)}`,
  // Upstash for Redis from the Vercel Marketplace (KV_REST_API_* variables).
  store: redisStore({
    client: fromUpstash(Redis.fromEnv()),
    prefix: "issues-mcp:",
  }),
  queue: vercelQueue({ topic: "mcp-events", send }),
});
