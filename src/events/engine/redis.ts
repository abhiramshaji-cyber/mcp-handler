import { randomUUID } from "node:crypto";
import type { McpEventsStore } from "./store";

/**
 * @experimental The one Redis capability the store needs: run a Lua script.
 * Every operation is a single-key script, so it is atomic on any Redis
 * (including Upstash's REST API, which has no WATCH) and safe on clusters.
 */
export interface RedisLike {
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
}

// Replies are prefixed so clients that JSON-parse replies (Upstash does by
// default) cannot turn stored strings into objects or numbers.
const GET = `
local v = redis.call('HMGET', KEYS[1], 'v', 'n')
if not v[2] then return false end
return { 's:' .. v[1], 'n:' .. v[2] }`;

const PUT = `
local current = redis.call('HGET', KEYS[1], 'n')
if ARGV[1] == '' then
  if current then return 0 end
elseif current ~= ARGV[1] then
  return 0
end
redis.call('DEL', KEYS[1])
redis.call('HSET', KEYS[1], 'v', ARGV[2], 'n', ARGV[3])
if ARGV[4] ~= '' then redis.call('PEXPIRE', KEYS[1], ARGV[4]) end
return 1`;

// Counters are plain strings; versioned values are hashes.
const DELETE = `
local kind = redis.call('TYPE', KEYS[1]).ok
if kind == 'none' then return 0 end
if kind == 'hash' then
  local current = redis.call('HGET', KEYS[1], 'n')
  if ARGV[1] ~= '' and current ~= ARGV[1] then return 0 end
elseif ARGV[1] ~= '' then
  return 0
end
redis.call('DEL', KEYS[1])
return 1`;

const INCREMENT = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return 'n:' .. n`;

const ADD = `return redis.call('SADD', KEYS[1], ARGV[1])`;
const REMOVE = `return redis.call('SREM', KEYS[1], ARGV[1])`;

const SCAN = `
local r = redis.call('SSCAN', KEYS[1], ARGV[1], 'COUNT', ARGV[2])
local out = { 'c:' .. r[1] }
for i, m in ipairs(r[2]) do out[i + 1] = 'm:' .. m end
return out`;

const strip = (value: unknown) => String(value).slice(2);

/**
 * @experimental A Redis-backed store. Versions are random, so a deleted and
 * recreated key never accepts an old version. Scans use SSCAN.
 */
export function redisStore({
  client,
  prefix = "mcp-events:",
}: {
  client: RedisLike;
  /** Namespace per logical MCP server when sharing a database. */
  prefix?: string;
}): McpEventsStore {
  const run = (script: string, key: string, ...args: string[]) =>
    client.eval(script, [prefix + key], args);
  return {
    async get(key) {
      const reply = (await run(GET, key)) as unknown[] | null;
      return reply
        ? { value: strip(reply[0]), version: strip(reply[1]) }
        : null;
    },
    async put(key, value, { version, ttlMs }) {
      if (ttlMs !== undefined && !(Number.isSafeInteger(ttlMs) && ttlMs > 0))
        throw new RangeError("ttlMs must be a positive integer");
      const reply = await run(
        PUT,
        key,
        version ?? "",
        value,
        randomUUID(),
        ttlMs === undefined ? "" : String(ttlMs),
      );
      return Number(reply) === 1;
    },
    async delete(key, options) {
      return Number(await run(DELETE, key, options?.version ?? "")) === 1;
    },
    async increment(key, ttlMs) {
      return Number(strip(await run(INCREMENT, key, String(ttlMs))));
    },
    async addToIndex(index, member) {
      await run(ADD, index, member);
    },
    async removeFromIndex(index, member) {
      await run(REMOVE, index, member);
    },
    async scanIndex(index, cursor, count) {
      const [next, ...members] = (await run(
        SCAN,
        index,
        cursor ?? "0",
        String(count),
      )) as unknown[];
      const position = strip(next);
      return {
        members: members.map(strip),
        ...(position !== "0" ? { cursor: position } : {}),
      };
    },
  };
}

/**
 * @experimental Adapt an `@upstash/redis` client, e.g. `Redis.fromEnv()`
 * (reads the Vercel Marketplace `KV_REST_API_*` variables).
 */
export function fromUpstash(redis: {
  eval(script: string, keys: string[], args: unknown[]): Promise<unknown>;
}): RedisLike {
  return { eval: (script, keys, args) => redis.eval(script, keys, args) };
}

/** @experimental Adapt a connected `redis` (node-redis v4+) client. */
export function fromNodeRedis(redis: {
  eval(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown>;
}): RedisLike {
  return {
    eval: (script, keys, args) => redis.eval(script, { keys, arguments: args }),
  };
}
