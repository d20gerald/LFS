import { describe, expect, it } from "vitest";
import {
  buttonId,
  close,
  expire,
  isExpired,
  juiceLabel,
  openSeats,
  parseButtonId,
  tryJoin,
  tryLeave,
  validateLobbyInput,
  type Lobby,
} from "../src/lobby.js";

const NOW = 1_700_000_000_000;

function makeLobby(overrides: Partial<Lobby> = {}): Lobby {
  return {
    id: 1,
    guildId: "g",
    channelId: "c",
    messageId: "m",
    hostId: "host",
    serverName: "OFFE",
    password: null,
    vibe: "casual",
    seats: 3,
    juice: 0,
    region: "auto",
    notes: null,
    status: "open",
    createdAt: NOW,
    expiresAt: NOW + 60_000,
    closedAt: null,
    voiceChannelId: null,
    players: ["host"],
    ...overrides,
  };
}

describe("validateLobbyInput", () => {
  const base = { serverName: "OFFE", vibe: "casual" as const, seats: 4, juice: 0, region: "auto" };

  it("accepts a minimal valid lobby and normalizes blanks to null", () => {
    const result = validateLobbyInput({ ...base, password: "   ", notes: "" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.password).toBeNull();
      expect(result.value.notes).toBeNull();
    }
  });

  it("trims the server name and keeps a password", () => {
    const result = validateLobbyInput({ ...base, serverName: "  OFFE ", password: "hunter2" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.serverName).toBe("OFFE");
      expect(result.value.password).toBe("hunter2");
    }
  });

  it("rejects a blank server name", () => {
    const result = validateLobbyInput({ ...base, serverName: "  " });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatch(/Server name is required/);
  });

  it("rejects seats outside 2 to 4 and juice outside 0 to 13", () => {
    expect(validateLobbyInput({ ...base, seats: 1 }).ok).toBe(false);
    expect(validateLobbyInput({ ...base, seats: 5 }).ok).toBe(false);
    expect(validateLobbyInput({ ...base, seats: 2.5 }).ok).toBe(false);
    expect(validateLobbyInput({ ...base, juice: -1 }).ok).toBe(false);
    expect(validateLobbyInput({ ...base, juice: 14 }).ok).toBe(false);
    expect(validateLobbyInput({ ...base, juice: 13 }).ok).toBe(true);
  });

  it("rejects unknown vibes and regions", () => {
    expect(validateLobbyInput({ ...base, vibe: "sweaty" as never }).ok).toBe(false);
    expect(validateLobbyInput({ ...base, region: "moon" }).ok).toBe(false);
  });

  it("collects every error at once", () => {
    const result = validateLobbyInput({ ...base, serverName: "", seats: 9, juice: 99 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toHaveLength(3);
  });
});

describe("tryJoin", () => {
  it("adds a player and stays open while seats remain", () => {
    const result = tryJoin(makeLobby(), "a");
    expect(result.kind).toBe("joined");
    if (result.kind === "joined") {
      expect(result.lobby.players).toEqual(["host", "a"]);
      expect(result.lobby.status).toBe("open");
      expect(result.nowFull).toBe(false);
      expect(openSeats(result.lobby)).toBe(1);
    }
  });

  it("flips to full when the last seat is taken", () => {
    const result = tryJoin(makeLobby({ players: ["host", "a"] }), "b");
    expect(result.kind).toBe("joined");
    if (result.kind === "joined") {
      expect(result.nowFull).toBe(true);
      expect(result.lobby.status).toBe("full");
    }
  });

  it("refuses duplicate joins, full lobbies and closed lobbies", () => {
    expect(tryJoin(makeLobby(), "host").kind).toBe("already-in");
    expect(tryJoin(makeLobby({ players: ["host", "a", "b"], status: "full" }), "c").kind).toBe("full");
    expect(tryJoin(makeLobby({ status: "closed" }), "c").kind).toBe("not-open");
    expect(tryJoin(makeLobby({ status: "expired" }), "c").kind).toBe("not-open");
  });

  it("does not mutate the input lobby", () => {
    const lobby = makeLobby();
    tryJoin(lobby, "a");
    expect(lobby.players).toEqual(["host"]);
  });
});

describe("tryLeave", () => {
  it("removes a crew member and reopens a full lobby", () => {
    const full = makeLobby({ players: ["host", "a", "b"], status: "full" });
    const result = tryLeave(full, "a");
    expect(result.kind).toBe("left");
    if (result.kind === "left") {
      expect(result.lobby.players).toEqual(["host", "b"]);
      expect(result.lobby.status).toBe("open");
    }
  });

  it("stops the host from leaving and ignores strangers", () => {
    expect(tryLeave(makeLobby(), "host").kind).toBe("host-cannot-leave");
    expect(tryLeave(makeLobby(), "nobody").kind).toBe("not-in");
    expect(tryLeave(makeLobby({ status: "closed", players: ["host", "a"] }), "a").kind).toBe("not-open");
  });
});

describe("lifecycle", () => {
  it("closes and expires with a timestamp", () => {
    expect(close(makeLobby(), NOW + 5)).toMatchObject({ status: "closed", closedAt: NOW + 5 });
    expect(expire(makeLobby(), NOW + 5)).toMatchObject({ status: "expired", closedAt: NOW + 5 });
  });

  it("only active lobbies can be expired", () => {
    expect(isExpired(makeLobby(), NOW + 60_000)).toBe(true);
    expect(isExpired(makeLobby(), NOW + 59_999)).toBe(false);
    expect(isExpired(makeLobby({ status: "closed" }), NOW + 999_999)).toBe(false);
  });
});

describe("labels and button ids", () => {
  it("describes juice like a Hades heat gauge", () => {
    expect(juiceLabel(0)).toMatch(/No Juice/);
    expect(juiceLabel(7)).toMatch(/7\/13/);
    expect(juiceLabel(13)).toMatch(/max/);
  });

  it("round-trips button ids and rejects junk", () => {
    expect(parseButtonId(buttonId("join", 42))).toEqual({ action: "join", lobbyId: 42 });
    expect(parseButtonId("lfs:close:7")).toEqual({ action: "close", lobbyId: 7 });
    expect(parseButtonId("lfs:nuke:7")).toBeNull();
    expect(parseButtonId("other:join:7")).toBeNull();
  });
});
