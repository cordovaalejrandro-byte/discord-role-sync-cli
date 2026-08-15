import assert from "node:assert/strict";
import test from "node:test";

import {
  DiscordApi,
  DiscordApiError,
  applyRoleChanges,
  collectParticipants,
  parseArgs,
  reactionKey,
} from "../discord-role-sync.mjs";

const baseEnvironment = {
  DISCORD_BOT_TOKEN: "test-token",
  DISCORD_SERVER_ID: "111111111111111111",
  DISCORD_MESSAGE_ID: "222222222222222222",
  DISCORD_ROLE_ID: "333333333333333333",
  DISCORD_ACTION: "ADD",
};

test("parseArgs accepts environment configuration and CLI overrides", () => {
  const options = parseArgs(["--action", "remove", "--dry-run", "--concurrency", "4"], baseEnvironment);
  assert.equal(options.action, "REMOVE");
  assert.equal(options.dryRun, true);
  assert.equal(options.concurrency, 4);
  assert.equal(options.serverId, baseEnvironment.DISCORD_SERVER_ID);
});

test("parseArgs rejects malformed snowflakes and actions", () => {
  assert.throws(
    () => parseArgs([], { ...baseEnvironment, DISCORD_SERVER_ID: "not-an-id" }),
    /Invalid Discord server ID/,
  );
  assert.throws(
    () => parseArgs([], { ...baseEnvironment, DISCORD_ACTION: "TOGGLE" }),
    /Action must be ADD or REMOVE/,
  );
  assert.throws(() => parseArgs(["--server", "wrong"], baseEnvironment), /Unknown option: --server/);
});

test("DiscordApi honors rate-limit retry_after before retrying", async () => {
  let calls = 0;
  const waits = [];
  const api = new DiscordApi("token", {
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? mockResponse(429, { retry_after: 0.001 })
        : mockResponse(200, { ok: true });
    },
    sleep: async (milliseconds) => waits.push(milliseconds),
  });

  assert.deepEqual(await api.request("/test"), { ok: true });
  assert.equal(calls, 2);
  assert.deepEqual(waits, [250]);
});

test("locateMessage scans accessible text channels when channel ID is omitted", async () => {
  const requestedPaths = [];
  const api = new DiscordApi("token", {
    fetchImpl: async (url) => {
      const path = new URL(url).pathname;
      requestedPaths.push(path);
      if (path.endsWith("/guilds/server/channels")) {
        return mockResponse(200, [
          { id: "channel-a", name: "first", type: 0 },
          { id: "category", name: "ignored", type: 4 },
          { id: "channel-b", name: "target", type: 0 },
        ]);
      }
      if (path.endsWith("/guilds/server/threads/active")) return mockResponse(200, { threads: [] });
      if (path.includes("/channels/channel-a/messages/")) return mockResponse(404, { message: "Unknown Message" });
      if (path.includes("/channels/channel-b/messages/")) return mockResponse(200, { id: "message" });
      throw new Error(`Unexpected request: ${path}`);
    },
  });

  const result = await api.locateMessage("server", "message");
  assert.equal(result.channel.id, "channel-b");
  assert.equal(result.message.id, "message");
  assert.equal(requestedPaths.some((path) => path.includes("category")), false);
});

test("reactionKey supports Unicode and custom emoji", () => {
  assert.equal(reactionKey({ id: null, name: "✅" }), "✅");
  assert.equal(reactionKey({ id: "444444444444444444", name: "shipit" }), "shipit:444444444444444444");
});

test("collectParticipants merges reactions and poll votes while excluding bots", async () => {
  const api = {
    async listReactionUsers() {
      return [
        { id: "1", username: "Ada" },
        { id: "2", username: "Bot", bot: true },
      ];
    },
    async listPollVoters() {
      return [
        { id: "1", username: "Ada" },
        { id: "3", username: "Lin" },
      ];
    },
  };
  const message = {
    id: "message",
    reactions: [{ emoji: { id: null, name: "✅" } }],
    poll: { answers: [{ answer_id: 7 }] },
  };
  const participants = await collectParticipants(api, "channel", message, {
    source: "auto",
    includeBots: false,
  });

  assert.deepEqual(
    participants.map((entry) => entry.user.id),
    ["1", "3"],
  );
  assert.deepEqual(participants[0].sources, ["reaction:✅", "poll:7"]);
});

test("applyRoleChanges is idempotent for ADD and records missing members", async () => {
  const calls = [];
  const api = {
    async getGuildMember(_serverId, userId) {
      if (userId === "missing") throw new DiscordApiError(404, "not found");
      return { roles: userId === "existing" ? [baseEnvironment.DISCORD_ROLE_ID] : [] };
    },
    async addRole(_serverId, userId) {
      calls.push(userId);
    },
  };
  const participants = [
    { user: { id: "existing", username: "Existing" }, sources: ["reaction:✅"] },
    { user: { id: "new", username: "New" }, sources: ["reaction:✅"] },
    { user: { id: "missing", username: "Missing" }, sources: ["poll:1"] },
  ];
  const logger = { log() {}, warn() {}, error() {} };
  const summary = await applyRoleChanges(api, participants, {
    serverId: baseEnvironment.DISCORD_SERVER_ID,
    roleId: baseEnvironment.DISCORD_ROLE_ID,
    action: "ADD",
    dryRun: false,
    concurrency: 2,
  }, logger);

  assert.deepEqual(calls, ["new"]);
  assert.deepEqual(summary, {
    found: 3,
    added: 1,
    removed: 0,
    unchanged: 1,
    skipped: 1,
    failed: 0,
    dryRun: false,
  });
});

test("applyRoleChanges removes only roles that are present", async () => {
  const calls = [];
  const api = {
    async getGuildMember(_serverId, userId) {
      return { roles: userId === "with-role" ? [baseEnvironment.DISCORD_ROLE_ID] : [] };
    },
    async removeRole(_serverId, userId) {
      calls.push(userId);
    },
  };
  const participants = [
    { user: { id: "with-role", username: "With" }, sources: ["poll:1"] },
    { user: { id: "without-role", username: "Without" }, sources: ["poll:1"] },
  ];
  const logger = { log() {}, warn() {}, error() {} };
  const summary = await applyRoleChanges(api, participants, {
    serverId: baseEnvironment.DISCORD_SERVER_ID,
    roleId: baseEnvironment.DISCORD_ROLE_ID,
    action: "REMOVE",
    dryRun: false,
    concurrency: 1,
  }, logger);

  assert.deepEqual(calls, ["with-role"]);
  assert.equal(summary.removed, 1);
  assert.equal(summary.unchanged, 1);
});

function mockResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: status === 404 ? "Not Found" : "",
    async text() {
      return body == null ? "" : JSON.stringify(body);
    },
  };
}

