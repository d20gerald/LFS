import { describe, expect, it } from "vitest";
import type { Lobby } from "../src/lobby.js";
import { buildLobbyButtons, buildLobbyEmbed, renderCrewCompleteMessage, renderServerDetails } from "../src/render.js";

const NOW = 1_700_000_000_000;

function makeLobby(overrides: Partial<Lobby> = {}): Lobby {
  return {
    id: 9,
    guildId: "g",
    channelId: "c",
    messageId: "m",
    hostId: "host",
    serverName: "OFFE",
    password: "hunter2",
    vibe: "tryhard",
    seats: 4,
    juice: 13,
    region: "usa-west",
    notes: "mic required",
    status: "open",
    createdAt: NOW,
    expiresAt: NOW + 90 * 60_000,
    closedAt: null,
    voiceChannelId: null,
    players: ["host", "a"],
    ...overrides,
  };
}

function embedText(lobby: Lobby): string {
  return JSON.stringify(buildLobbyEmbed(lobby));
}

describe("buildLobbyEmbed", () => {
  it("shows the voice room only while the lobby is active", () => {
    expect(embedText(makeLobby({ voiceChannelId: "vc" }))).toContain("<#vc>");
    expect(embedText(makeLobby({ voiceChannelId: "vc", status: "closed" }))).not.toContain("<#vc>");
    expect(embedText(makeLobby())).not.toContain("Voice chat");
  });

  it("never leaks the server name or password", () => {
    const text = embedText(makeLobby());
    expect(text).not.toContain("OFFE");
    expect(text).not.toContain("hunter2");
  });

  it("shows vibe, juice, region, crew count, empty seats and notes", () => {
    const text = embedText(makeLobby());
    expect(text).toContain("Try-hard");
    expect(text).toContain("Juice 13");
    expect(text).toContain("USA, West");
    expect(text).toContain("Crew (2/4)");
    expect(text).toContain("<@host> (host)");
    expect(text).toContain("<@a>");
    expect(text).toContain("mic required");
    expect((text.match(/_empty seat_/g) ?? []).length).toBe(2);
  });

  it("reflects each status in the description", () => {
    expect(embedText(makeLobby({ status: "open" }))).toContain("2 seats left");
    expect(embedText(makeLobby({ status: "full", players: ["host", "a", "b", "c"] }))).toContain("Crew complete");
    expect(embedText(makeLobby({ status: "closed" }))).toContain("Closed");
    expect(embedText(makeLobby({ status: "expired" }))).toContain("Expired");
  });
});

describe("buildLobbyButtons", () => {
  function disabledStates(lobby: Lobby): boolean[] {
    const row = buildLobbyButtons(lobby)[0]!.toJSON() as { components: Array<{ disabled?: boolean }> };
    return row.components.map((c) => c.disabled ?? false);
  }

  it("enables everything on an open lobby", () => {
    expect(disabledStates(makeLobby())).toEqual([false, false, false, false]);
  });

  it("disables Join only when the ship is full", () => {
    expect(disabledStates(makeLobby({ status: "full", players: ["host", "a", "b", "c"] }))).toEqual([
      true,
      false,
      false,
      false,
    ]);
  });

  it("disables every button once closed or expired", () => {
    expect(disabledStates(makeLobby({ status: "closed" }))).toEqual([true, true, true, true]);
    expect(disabledStates(makeLobby({ status: "expired" }))).toEqual([true, true, true, true]);
  });
});

describe("private text", () => {
  it("renders the server details with the password when set", () => {
    const text = renderServerDetails(makeLobby());
    expect(text).toContain("`OFFE`");
    expect(text).toContain("`hunter2`");
  });

  it("says none when there is no password", () => {
    expect(renderServerDetails(makeLobby({ password: null }))).toContain("Password:** none");
  });

  it("pings the host and lists the crew when complete", () => {
    const { content, userIds } = renderCrewCompleteMessage(makeLobby({ players: ["host", "a", "b", "c"] }));
    expect(content.startsWith("<@host>")).toBe(true);
    expect(content).toContain("<@a>, <@b>, <@c>");
    expect(userIds).toEqual(["host", "a", "b", "c"]);
  });
});
