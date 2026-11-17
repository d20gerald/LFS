import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LobbyStore } from "../src/db.js";
import { tryJoin } from "../src/lobby.js";

const NOW = 1_700_000_000_000;
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

  it("stores the message id after posting", () => {
    const lobby = store.createLobby({ guildId: "g", channelId: "c", hostId: "host", input: INPUT, now: NOW, ttlMs: 1 });
    store.setMessageId(lobby.id, "msg-1");
    expect(store.getLobby(lobby.id)?.messageId).toBe("msg-1");
  });
});
