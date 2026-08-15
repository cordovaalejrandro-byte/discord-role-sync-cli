#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const DISCORD_API_BASE = "https://discord.com/api/v10";
const TEXT_CHANNEL_TYPES = new Set([0, 5, 10, 11, 12, 15, 16]);
const ACTIONS = new Set(["ADD", "REMOVE"]);
const SOURCES = new Set(["auto", "reactions", "poll"]);

export class DiscordApiError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = "DiscordApiError";
    this.status = status;
    this.body = body;
  }
}

export function parseArgs(argv, env = process.env) {
  const values = {};
  const booleanFlags = new Set(["dry-run", "include-bots", "help"]);
  const valueFlags = new Set([
    "token",
    "server-id",
    "channel-id",
    "message-id",
    "role-id",
    "action",
    "source",
    "emoji",
    "concurrency",
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      throw new Error(`Unexpected argument: ${argument}`);
    }

    const key = argument.slice(2);
    if (booleanFlags.has(key)) {
      values[key] = true;
      continue;
    }
    if (!valueFlags.has(key)) {
      throw new Error(`Unknown option: --${key}`);
    }

    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    values[key] = value;
    index += 1;
  }

  if (values.help) return { help: true };

  const options = {
    token: values.token ?? env.DISCORD_BOT_TOKEN,
    serverId: values["server-id"] ?? env.DISCORD_SERVER_ID,
    channelId: values["channel-id"] ?? env.DISCORD_CHANNEL_ID,
    messageId: values["message-id"] ?? env.DISCORD_MESSAGE_ID,
    roleId: values["role-id"] ?? env.DISCORD_ROLE_ID,
    action: String(values.action ?? env.DISCORD_ACTION ?? "").toUpperCase(),
    source: String(values.source ?? env.DISCORD_SOURCE ?? "auto").toLowerCase(),
    emoji: values.emoji ?? env.DISCORD_EMOJI,
    dryRun: Boolean(values["dry-run"]),
    includeBots: Boolean(values["include-bots"]),
    concurrency: Number(values.concurrency ?? env.DISCORD_CONCURRENCY ?? 3),
  };

  for (const [name, value] of [
    ["DISCORD_BOT_TOKEN/--token", options.token],
    ["DISCORD_SERVER_ID/--server-id", options.serverId],
    ["DISCORD_MESSAGE_ID/--message-id", options.messageId],
    ["DISCORD_ROLE_ID/--role-id", options.roleId],
    ["DISCORD_ACTION/--action", options.action],
  ]) {
    if (!value) throw new Error(`Missing required value: ${name}`);
  }

  for (const [name, value] of [
    ["server ID", options.serverId],
    ["message ID", options.messageId],
    ["role ID", options.roleId],
    ["channel ID", options.channelId],
  ]) {
    if (value && !/^\d{16,22}$/.test(value)) {
      throw new Error(`Invalid Discord ${name}: ${value}`);
    }
  }

  if (!ACTIONS.has(options.action)) {
    throw new Error(`Action must be ADD or REMOVE, received: ${options.action || "(empty)"}`);
  }
  if (!SOURCES.has(options.source)) {
    throw new Error(`Source must be auto, reactions, or poll, received: ${options.source}`);
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 10) {
    throw new Error("Concurrency must be an integer between 1 and 10.");
  }

  return options;
}

export class DiscordApi {
  constructor(token, { fetchImpl = globalThis.fetch, sleep = defaultSleep, baseUrl = DISCORD_API_BASE } = {}) {
    if (!fetchImpl) throw new Error("A fetch implementation is required.");
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async request(path, init = {}) {
    const url = `${this.baseUrl}${path}`;

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await this.fetchImpl(url, {
        ...init,
        headers: {
          Authorization: `Bot ${this.token}`,
          "User-Agent": "DiscordBot (discord-reaction-role-sync, 1.0.0)",
          ...init.headers,
        },
      });

      if (response.status === 429) {
        const rateLimit = await readResponse(response);
        const retryAfterMs = Math.max(250, Math.ceil(Number(rateLimit?.retry_after ?? 1) * 1000));
        if (attempt === 5) {
          throw new DiscordApiError(429, "Discord rate limit did not clear after retries.", rateLimit);
        }
        await this.sleep(retryAfterMs);
        continue;
      }

      const body = await readResponse(response);
      if (!response.ok) {
        const detail = body?.message ?? response.statusText ?? "Discord API request failed";
        throw new DiscordApiError(response.status, `${response.status} ${detail}`, body);
      }
      return body;
    }

    throw new Error("Unreachable request state.");
  }

  async locateMessage(serverId, messageId, channelId) {
    if (channelId) {
      const channel = await this.request(`/channels/${channelId}`);
      if (channel.guild_id !== serverId) {
        throw new Error(`Channel ${channelId} does not belong to server ${serverId}.`);
      }
      const message = await this.request(`/channels/${channelId}/messages/${messageId}`);
      return { channel, message };
    }

    const channels = await this.request(`/guilds/${serverId}/channels`);
    let threads = [];
    try {
      const activeThreads = await this.request(`/guilds/${serverId}/threads/active`);
      threads = activeThreads?.threads ?? [];
    } catch (error) {
      if (!(error instanceof DiscordApiError) || ![403, 404].includes(error.status)) throw error;
    }

    const candidates = [...channels, ...threads].filter((channel) => TEXT_CHANNEL_TYPES.has(channel.type));
    for (const channel of candidates) {
      try {
        const message = await this.request(`/channels/${channel.id}/messages/${messageId}`);
        return { channel, message };
      } catch (error) {
        if (error instanceof DiscordApiError && [403, 404].includes(error.status)) continue;
        throw error;
      }
    }

    throw new Error(
      `Message ${messageId} was not found in accessible text channels. Pass --channel-id if it is inside an archived thread.`,
    );
  }

  async listReactionUsers(channelId, messageId, emoji) {
    return this.#listUsers(
      (after) =>
        `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}?limit=100${
          after ? `&after=${after}` : ""
        }`,
      (body) => body ?? [],
    );
  }

  async listPollVoters(channelId, messageId, answerId) {
    return this.#listUsers(
      (after) =>
        `/channels/${channelId}/polls/${messageId}/answers/${answerId}?limit=100${
          after ? `&after=${after}` : ""
        }`,
      (body) => (Array.isArray(body) ? body : body?.users ?? []),
    );
  }

  async #listUsers(buildPath, getUsers) {
    const users = [];
    let after;
    while (true) {
      const body = await this.request(buildPath(after));
      const page = getUsers(body);
      users.push(...page);
      if (page.length < 100) break;
      after = page.at(-1)?.id;
      if (!after) break;
    }
    return users;
  }

  getGuildMember(serverId, userId) {
    return this.request(`/guilds/${serverId}/members/${userId}`);
  }

  addRole(serverId, userId, roleId) {
    return this.request(`/guilds/${serverId}/members/${userId}/roles/${roleId}`, {
      method: "PUT",
      headers: { "X-Audit-Log-Reason": encodeURIComponent("One-shot reaction/poll role sync") },
    });
  }

  removeRole(serverId, userId, roleId) {
    return this.request(`/guilds/${serverId}/members/${userId}/roles/${roleId}`, {
      method: "DELETE",
      headers: { "X-Audit-Log-Reason": encodeURIComponent("One-shot reaction/poll role sync") },
    });
  }
}

export async function collectParticipants(api, channelId, message, options) {
  const participants = new Map();

  if (options.source !== "poll") {
    const reactions = (message.reactions ?? []).filter((reaction) => {
      if (!options.emoji) return true;
      return reactionKey(reaction.emoji) === options.emoji || reaction.emoji?.name === options.emoji;
    });

    for (const reaction of reactions) {
      const emoji = reactionKey(reaction.emoji);
      const users = await api.listReactionUsers(channelId, message.id, emoji);
      addUsers(participants, users, options.includeBots, `reaction:${emoji}`);
    }
  }

  if (options.source !== "reactions" && message.poll?.answers?.length) {
    for (const answer of message.poll.answers) {
      const users = await api.listPollVoters(channelId, message.id, answer.answer_id);
      addUsers(participants, users, options.includeBots, `poll:${answer.answer_id}`);
    }
  }

  return [...participants.values()];
}

export async function applyRoleChanges(api, participants, options, logger = console) {
  const summary = {
    found: participants.length,
    added: 0,
    removed: 0,
    unchanged: 0,
    skipped: 0,
    failed: 0,
    dryRun: options.dryRun,
  };

  await mapLimit(participants, options.concurrency, async ({ user, sources }) => {
    const label = user.global_name ?? user.username ?? user.id;
    let member;
    try {
      member = await api.getGuildMember(options.serverId, user.id);
    } catch (error) {
      if (error instanceof DiscordApiError && error.status === 404) {
        summary.skipped += 1;
        logger.warn(`SKIPPED ${label} (${user.id}) — no longer a server member`);
        return;
      }
      summary.failed += 1;
      logger.error(`FAILED ${label} (${user.id}) — ${error.message}`);
      return;
    }

    const hasRole = member.roles?.includes(options.roleId) ?? false;
    const sourceLabel = sources.join(", ");
    if (options.action === "ADD" && hasRole) {
      summary.unchanged += 1;
      logger.log(`UNCHANGED ${label} (${user.id}) — already has role [${sourceLabel}]`);
      return;
    }
    if (options.action === "REMOVE" && !hasRole) {
      summary.unchanged += 1;
      logger.log(`UNCHANGED ${label} (${user.id}) — role already absent [${sourceLabel}]`);
      return;
    }

    const verb = options.action === "ADD" ? "ADDED" : "REMOVED";
    if (options.dryRun) {
      summary.unchanged += 1;
      logger.log(`WOULD_${verb} ${label} (${user.id}) [${sourceLabel}]`);
      return;
    }

    try {
      if (options.action === "ADD") {
        await api.addRole(options.serverId, user.id, options.roleId);
        summary.added += 1;
      } else {
        await api.removeRole(options.serverId, user.id, options.roleId);
        summary.removed += 1;
      }
      logger.log(`${verb} ${label} (${user.id}) [${sourceLabel}]`);
    } catch (error) {
      summary.failed += 1;
      logger.error(`FAILED ${label} (${user.id}) — ${error.message}`);
    }
  });

  return summary;
}

export async function run(options, { api = new DiscordApi(options.token), logger = console } = {}) {
  logger.log(`Locating message ${options.messageId} in server ${options.serverId}...`);
  const { channel, message } = await api.locateMessage(options.serverId, options.messageId, options.channelId);
  logger.log(`Found message in #${channel.name ?? channel.id} (${channel.id}).`);

  const participants = await collectParticipants(api, channel.id, message, options);
  if (participants.length === 0) {
    logger.warn("No qualifying reactors or poll voters were found. No roles were changed.");
    return { found: 0, added: 0, removed: 0, unchanged: 0, skipped: 0, failed: 0, dryRun: options.dryRun };
  }

  logger.log(`${participants.length} unique participant(s) found. Applying ${options.action}...`);
  const summary = await applyRoleChanges(api, participants, options, logger);
  logger.log(`Summary: ${JSON.stringify(summary)}`);
  return summary;
}

export function printHelp() {
  console.log(`
Discord reaction/poll role sync

Usage:
  node discord-role-sync.mjs --server-id ID --message-id ID --role-id ID --action ADD

Required (flags or environment variables):
  --server-id ID       DISCORD_SERVER_ID
  --message-id ID      DISCORD_MESSAGE_ID
  --role-id ID         DISCORD_ROLE_ID
  --action ADD|REMOVE  DISCORD_ACTION
  --token TOKEN        DISCORD_BOT_TOKEN

Optional:
  --channel-id ID      Skip server-wide text-channel discovery
  --source TYPE        auto (default), reactions, or poll
  --emoji VALUE        Only include one Unicode emoji or custom name:id
  --dry-run            Report changes without modifying roles
  --include-bots       Include bot users (excluded by default)
  --concurrency N      Parallel member operations, 1-10 (default: 3)
  --help               Show this help
`);
}

export function reactionKey(emoji) {
  if (!emoji?.name) throw new Error("Discord returned a reaction without an emoji name.");
  return emoji.id ? `${emoji.name}:${emoji.id}` : emoji.name;
}

function addUsers(map, users, includeBots, source) {
  for (const user of users) {
    if (!includeBots && user.bot) continue;
    const existing = map.get(user.id);
    if (existing) {
      if (!existing.sources.includes(source)) existing.sources.push(source);
    } else {
      map.set(user.id, { user, sources: [source] });
    }
  }
}

async function mapLimit(items, limit, worker) {
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const itemIndex = index;
      index += 1;
      await worker(items[itemIndex]);
    }
  });
  await Promise.all(runners);
}

async function readResponse(response) {
  if (response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      printHelp();
      return;
    }
    const summary = await run(options);
    if (summary.failed > 0) process.exitCode = 1;
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await main();

