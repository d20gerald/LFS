import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LobbyStore } from "../src/db.js";
import { tryJoin } from "../src/lobby.js";

const NOW = 1_700_000_000_000;

/** The lobbies table as shipped before voice rooms, for migration tests. */
const LEGACY_SCHEMA = `
CREATE TABLE lobbies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  host_id TEXT NOT NULL,
  server_name TEXT NOT NULL,
  password TEXT,
  vibe TEXT NOT NULL,
  seats INTEGER NOT NULL,
  juice INTEGER NOT NULL,
  region TEXT NOT NULL,
  notes TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  closed_at INTEGER
);
CREATE TABLE lobby_players (
  lobby_id INTEGER NOT NULL REFERENCES lobbies(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (lobby_id, user_id)
);
`;

const INPUT = {
  serverName: "OFFE",
  password: null,
  vibe: "casual" as const,
  seats: 2,
  juice: 3,
  region: "europe",
  notes: null,
};

describe("LobbyStore", () => {
  let store: LobbyStore;

  beforeEach(() => {
    store = new LobbyStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  it("creates a lobby with the host seated first", () => {
    const lobby = store.createLobby({ guildId: "g", channelId: "c", hostId: "host", input: INPUT, now: NOW, ttlMs: 1000 });
    expect(lobby.id).toBe(1);
    expect(lobby.players).toEqual(["host"]);
    expect(lobby.status).toBe("open");
    expect(lobby.expiresAt).toBe(NOW + 1000);
    expect(store.getLobby(1)).toEqual(lobby);
  });

  it("finds the active lobby a user hosts or joined, scoped to the guild", () => {
    const lobby = store.createLobby({ guildId: "g", channelId: "c", hostId: "host", input: INPUT, now: NOW, ttlMs: 1000 });
    expect(store.findActiveLobbyForUser("g", "host")?.id).toBe(lobby.id);
    expect(store.findActiveLobbyForUser("other-guild", "host")).toBeNull();
    expect(store.findActiveLobbyForUser("g", "a")).toBeNull();

    const joined = tryJoin(lobby, "a");
    if (joined.kind !== "joined") throw new Error("expected join");
    store.savePlayersAndStatus(joined.lobby, NOW + 1);
    expect(store.findActiveLobbyForUser("g", "a")?.id).toBe(lobby.id);
    expect(store.getLobby(lobby.id)?.status).toBe("full");

    store.setStatus(lobby.id, "closed", NOW + 2);
    expect(store.findActiveLobbyForUser("g", "a")).toBeNull();
  });

  it("lists overdue lobbies and skips closed ones", () => {
    const a = store.createLobby({ guildId: "g", channelId: "c", hostId: "h1", input: INPUT, now: NOW, ttlMs: 10 });
    store.createLobby({ guildId: "g", channelId: "c", hostId: "h2", input: INPUT, now: NOW, ttlMs: 10_000 });
    const c = store.createLobby({ guildId: "g", channelId: "c", hostId: "h3", input: INPUT, now: NOW, ttlMs: 10 });
    store.setStatus(c.id, "closed", NOW + 5);

    expect(store.listExpired(NOW + 10).map((l) => l.id)).toEqual([a.id]);
    expect(store.listActive("g").map((l) => l.id)).toEqual([1, 2]);
  });

  it("stores and clears the voice channel id", () => {
    const lobby = store.createLobby({ guildId: "g", channelId: "c", hostId: "host", input: INPUT, now: NOW, ttlMs: 1 });
    expect(lobby.voiceChannelId).toBeNull();
    store.setVoiceChannelId(lobby.id, "vc-1");
    expect(store.getLobby(lobby.id)?.voiceChannelId).toBe("vc-1");
    store.setVoiceChannelId(lobby.id, null);
    expect(store.getLobby(lobby.id)?.voiceChannelId).toBeNull();
  });

  it("adds the voice column to a database from before voice rooms existed", () => {
    const legacy = new DatabaseSync(":memory:");
    legacy.exec(LEGACY_SCHEMA);
    // Reopening the same in-memory handle is not possible, so exercise the migration on a temp file.
    legacy.close();
    const dir = mkdtempSync(join(tmpdir(), "lfs-"));
    const path = join(dir, "old.sqlite");
    const old = new DatabaseSync(path);
    old.exec(LEGACY_SCHEMA);
    old.exec(
      "INSERT INTO lobbies (guild_id, channel_id, host_id, server_name, vibe, seats, juice, region, status, created_at, expires_at) VALUES ('g','c','h','OFFE','casual',2,0,'auto','open',1,2)",
    );
    old.close();
    const migrated = new LobbyStore(path);
    expect(migrated.getLobby(1)?.voiceChannelId).toBeNull();
    migrated.setVoiceChannelId(1, "vc-2");
    expect(migrated.getLobby(1)?.voiceChannelId).toBe("vc-2");
    migrated.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("stores the message id after posting", () => {
    const lobby = store.createLobby({ guildId: "g", channelId: "c", hostId: "host", input: INPUT, now: NOW, ttlMs: 1 });
    store.setMessageId(lobby.id, "msg-1");
    expect(store.getLobby(lobby.id)?.messageId).toBe("msg-1");
  });
});
