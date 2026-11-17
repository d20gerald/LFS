/**
 * Handler tests using hand-rolled fakes for the Discord objects the glue code touches.
 * No network, no discord.js client.
 */
import type { ButtonInteraction, ChatInputCommandInteraction, Client } from "discord.js";
import { beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { LobbyStore } from "../src/db.js";
import {
  handleButton,
  handleLfsCommand,
  handleLobbyCommand,
  sweepExpiredLobbies,
  type Context,
} from "../src/handlers.js";
import { buttonId, type Lobby } from "../src/lobby.js";

const NOW = 1_700_000_000_000;

type Payload = Record<string, unknown> & { content?: string; embeds?: unknown[]; components?: unknown[] };

interface Calls {
  reply: Payload[];
  followUp: Payload[];
  update: Payload[];
}

function fakeCommand(opts: {
  guildId?: string | null;
  channelId?: string;
  userId?: string;
  strings?: Record<string, string | null>;
  ints?: Record<string, number | null>;
  sub?: string;
} = {}) {
  const calls: Calls = { reply: [], followUp: [], update: [] };
  const guildId = opts.guildId === undefined ? "g" : opts.guildId;
  const interaction = {
    guildId,
    channelId: opts.channelId ?? "c",
    user: { id: opts.userId ?? "host" },
    inGuild: () => guildId !== null,
    options: {
      getString: (name: string) => opts.strings?.[name] ?? null,
      getInteger: (name: string) => opts.ints?.[name] ?? null,
      getSubcommand: () => opts.sub ?? "",
    },
    reply: async (payload: Payload) => {
      calls.reply.push(payload);
      return { resource: { message: { id: "msg-1" } } };
    },
    followUp: async (payload: Payload) => {
      calls.followUp.push(payload);
    },
  };
  return { interaction: interaction as unknown as ChatInputCommandInteraction, calls };
}

function fakeButton(customId: string, userId: string, opts: { manageMessages?: boolean } = {}) {
  const calls: Calls = { reply: [], followUp: [], update: [] };
  const interaction = {
    customId,
    user: { id: userId },
    memberPermissions: { has: () => opts.manageMessages ?? false },
    reply: async (payload: Payload) => {
      calls.reply.push(payload);
    },
    followUp: async (payload: Payload) => {
      calls.followUp.push(payload);
    },
    update: async (payload: Payload) => {
      calls.update.push(payload);
    },
  };
  return { interaction: interaction as unknown as ButtonInteraction, calls };
}

function fakeClient() {
  const sent: Payload[] = [];
  const edits: Payload[] = [];
  const message = {
    edit: async (payload: Payload) => {
      edits.push(payload);
    },
  };
  const channel = {
    isTextBased: () => true,
    isSendable: () => true,
    messages: { fetch: async () => message },
    send: async (payload: Payload) => {
      sent.push(payload);
    },
  };
  const client = { channels: { fetch: async () => channel } } as unknown as Client;
  return { client, sent, edits };
}

function makeContext(overrides: Partial<Config> = {}) {
  const { client, sent, edits } = fakeClient();
  const store = new LobbyStore(":memory:");
  const config: Config = {
    token: "t",
    clientId: "app",
    guildId: null,
    allowedChannelIds: new Set(),
    lobbyTtlMs: 90 * 60_000,
    dbPath: ":memory:",
    ...overrides,
  };
  let now = NOW;
  const ctx: Context = { client, store, config, now: () => now };
  return { ctx, store, sent, edits, setNow: (t: number) => (now = t) };
}

const BASE_STRINGS = { server: "OFFE", vibe: "casual" };

async function postLobby(ctx: Context, userId = "host", extra: Partial<Parameters<typeof fakeCommand>[0]> = {}) {
  const cmd = fakeCommand({ userId, strings: BASE_STRINGS, ints: { seats: 3 }, ...extra });
  await handleLobbyCommand(ctx, cmd.interaction);
  const lobby = ctx.store.listActive("g").find((l) => l.hostId === userId);
  return { cmd, lobby };
}

function buttonsDisabled(payload: Payload): boolean[] {
  const rows = payload.components as Array<{ toJSON: () => { components: Array<{ disabled?: boolean }> } }>;
  return rows[0]!.toJSON().components.map((c) => c.disabled ?? false);
}

describe("/lobby", () => {
  let t: ReturnType<typeof makeContext>;
  beforeEach(() => {
    t = makeContext();
  });

  it("posts the embed, records the message id and follows up privately", async () => {
    const { cmd, lobby } = await postLobby(t.ctx);
    expect(lobby).toBeDefined();
    expect(lobby?.messageId).toBe("msg-1");
    expect(lobby?.players).toEqual(["host"]);
    expect(cmd.calls.reply).toHaveLength(1);
    const posted = JSON.stringify(cmd.calls.reply[0]!.embeds);
    expect(posted).not.toContain("OFFE");
    expect(cmd.calls.followUp[0]!.content).toContain("stay hidden");
    expect(cmd.calls.followUp[0]!.content).toContain("Tip: a server password");
  });

  it("warns louder about a missing password on a try-hard lobby", async () => {
    const { cmd } = await postLobby(t.ctx, "host", { strings: { server: "OFFE", vibe: "tryhard" } });
    expect(cmd.calls.followUp[0]!.content).toContain("⚠️ No password set");
  });

  it("does not nag when a password is set", async () => {
    const { cmd } = await postLobby(t.ctx, "host", { strings: { ...BASE_STRINGS, password: "pw" } });
    expect(cmd.calls.followUp[0]!.content).not.toContain("password keeps");
    expect(cmd.calls.followUp[0]!.content).not.toContain("⚠️");
  });

  it("refuses a second lobby from someone already hosting", async () => {
    await postLobby(t.ctx);
    const { cmd } = await postLobby(t.ctx);
    expect(cmd.calls.reply[0]!.content).toContain("already hosting lobby #1");
    expect(t.store.listActive("g")).toHaveLength(1);
  });

  it("refuses outside DMs and outside allowed channels", async () => {
    const dm = fakeCommand({ guildId: null, strings: BASE_STRINGS });
    await handleLobbyCommand(t.ctx, dm.interaction);
    expect(dm.calls.reply[0]!.content).toContain("inside a server");

    const restricted = makeContext({ allowedChannelIds: new Set(["lfg-channel"]) });
    const wrong = fakeCommand({ channelId: "general", strings: BASE_STRINGS });
    await handleLobbyCommand(restricted.ctx, wrong.interaction);
    expect(wrong.calls.reply[0]!.content).toContain("<#lfg-channel>");
    expect(restricted.store.listActive("g")).toHaveLength(0);
  });

  it("reports validation errors instead of posting", async () => {
    const cmd = fakeCommand({ strings: { server: "   ", vibe: "casual" } });
    await handleLobbyCommand(t.ctx, cmd.interaction);
    expect(cmd.calls.reply[0]!.content).toContain("Server name is required");
    expect(t.store.listActive("g")).toHaveLength(0);
  });
});

describe("buttons", () => {
  let t: ReturnType<typeof makeContext>;
  let lobby: Lobby;
  beforeEach(async () => {
    t = makeContext();
    lobby = (await postLobby(t.ctx)).lobby!;
  });

  it("join reveals the server details privately and updates the post", async () => {
    const btn = fakeButton(buttonId("join", lobby.id), "a");
    await handleButton(t.ctx, btn.interaction);
    expect(btn.calls.update).toHaveLength(1);
    expect(btn.calls.followUp[0]!.content).toContain("`OFFE`");
    expect(JSON.stringify(btn.calls.update[0]!.embeds)).toContain("Crew (2/3)");
    expect(t.store.getLobby(lobby.id)?.players).toEqual(["host", "a"]);
    expect(t.sent).toHaveLength(0);
  });

  it("pings the host and crew when the last seat fills", async () => {
    await handleButton(t.ctx, fakeButton(buttonId("join", lobby.id), "a").interaction);
    const last = fakeButton(buttonId("join", lobby.id), "b");
    await handleButton(t.ctx, last.interaction);
    expect(t.store.getLobby(lobby.id)?.status).toBe("full");
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]!.content).toContain("<@host> your crew is complete: <@a>, <@b>");
    expect(buttonsDisabled(last.calls.update[0]!)[0]).toBe(true);
  });

  it("turns away a joiner who is already in another lobby", async () => {
    const other = (await postLobby(t.ctx, "other-host")).lobby!;
    await handleButton(t.ctx, fakeButton(buttonId("join", other.id), "a").interaction);
    const btn = fakeButton(buttonId("join", lobby.id), "a");
    await handleButton(t.ctx, btn.interaction);
    expect(btn.calls.reply[0]!.content).toContain(`already in lobby #${other.id}`);
    expect(t.store.getLobby(lobby.id)?.players).toEqual(["host"]);
  });

  it("re-sends details to someone already aboard", async () => {
    const btn = fakeButton(buttonId("join", lobby.id), "host");
    await handleButton(t.ctx, btn.interaction);
    expect(btn.calls.reply[0]!.content).toContain("already aboard");
    expect(btn.calls.reply[0]!.content).toContain("`OFFE`");
  });

  it("seats only as many as fit when clicks race", async () => {
    await handleButton(t.ctx, fakeButton(buttonId("join", lobby.id), "a").interaction);
    const b = fakeButton(buttonId("join", lobby.id), "b");
    const c = fakeButton(buttonId("join", lobby.id), "c");
    await Promise.all([handleButton(t.ctx, b.interaction), handleButton(t.ctx, c.interaction)]);
    const final = t.store.getLobby(lobby.id)!;
    expect(final.players).toHaveLength(3);
    expect(final.status).toBe("full");
    const loser = final.players.includes("b") ? c : b;
    expect(loser.calls.followUp[0]!.content).toContain("filled up");
    expect(t.sent).toHaveLength(1);
  });

  it("leave reopens a full lobby, and the host is told to close instead", async () => {
    await handleButton(t.ctx, fakeButton(buttonId("join", lobby.id), "a").interaction);
    await handleButton(t.ctx, fakeButton(buttonId("join", lobby.id), "b").interaction);
    const leave = fakeButton(buttonId("leave", lobby.id), "a");
    await handleButton(t.ctx, leave.interaction);
    expect(t.store.getLobby(lobby.id)).toMatchObject({ status: "open", players: ["host", "b"] });
    expect(buttonsDisabled(leave.calls.update[0]!)[0]).toBe(false);

    const hostLeave = fakeButton(buttonId("leave", lobby.id), "host");
    await handleButton(t.ctx, hostLeave.interaction);
    expect(hostLeave.calls.reply[0]!.content).toContain("Use **Close**");

    const stranger = fakeButton(buttonId("leave", lobby.id), "nobody");
    await handleButton(t.ctx, stranger.interaction);
    expect(stranger.calls.reply[0]!.content).toContain("not in this lobby");
  });

  it("details are for crew only", async () => {
    const outsider = fakeButton(buttonId("details", lobby.id), "nobody");
    await handleButton(t.ctx, outsider.interaction);
    expect(outsider.calls.reply[0]!.content).toContain("Join the lobby first");

    const host = fakeButton(buttonId("details", lobby.id), "host");
    await handleButton(t.ctx, host.interaction);
    expect(host.calls.reply[0]!.content).toContain("`OFFE`");
  });

  it("close is host or moderator only and disables every button", async () => {
    const rando = fakeButton(buttonId("close", lobby.id), "nobody");
    await handleButton(t.ctx, rando.interaction);
    expect(rando.calls.reply[0]!.content).toContain("Only the host");
    expect(t.store.getLobby(lobby.id)?.status).toBe("open");

    const mod = fakeButton(buttonId("close", lobby.id), "mod", { manageMessages: true });
    await handleButton(t.ctx, mod.interaction);
    expect(t.store.getLobby(lobby.id)?.status).toBe("closed");
    expect(buttonsDisabled(mod.calls.update[0]!)).toEqual([true, true, true, true]);
    expect(mod.calls.followUp[0]!.content).toContain("closed");
  });

  it("joining a closed lobby is refused gracefully", async () => {
    await handleButton(t.ctx, fakeButton(buttonId("close", lobby.id), "host").interaction);
    const late = fakeButton(buttonId("join", lobby.id), "a");
    await handleButton(t.ctx, late.interaction);
    expect(late.calls.followUp[0]!.content).toContain("no longer open");
  });

  it("ignores unknown lobbies and foreign custom ids", async () => {
    const missing = fakeButton(buttonId("join", 999), "a");
    await handleButton(t.ctx, missing.interaction);
    expect(missing.calls.reply[0]!.content).toContain("no longer exists");

    const foreign = fakeButton("otherbot:thing:1", "a");
    await handleButton(t.ctx, foreign.interaction);
    expect(foreign.calls.reply).toHaveLength(0);
  });
});

describe("expiry sweep", () => {
  it("expires overdue lobbies and edits their posts, leaving fresh ones alone", async () => {
    const t = makeContext({ lobbyTtlMs: 1000 });
    const { lobby } = await postLobby(t.ctx);
    expect(await sweepExpiredLobbies(t.ctx)).toBe(0);

    t.setNow(NOW + 1000);
    expect(await sweepExpiredLobbies(t.ctx)).toBe(1);
    expect(t.store.getLobby(lobby!.id)?.status).toBe("expired");
    expect(t.edits).toHaveLength(1);
    expect(JSON.stringify(t.edits[0]!.embeds)).toContain("Expired");
    expect(buttonsDisabled(t.edits[0]!)).toEqual([true, true, true, true]);

    expect(await sweepExpiredLobbies(t.ctx)).toBe(0);
  });
});

describe("/lfs", () => {
  it("lists open lobbies with jump links and explains itself", async () => {
    const t = makeContext();
    const empty = fakeCommand({ sub: "lobbies" });
    await handleLfsCommand(t.ctx, empty.interaction);
    expect(empty.calls.reply[0]!.content).toContain("No open lobbies");

    await postLobby(t.ctx);
    const list = fakeCommand({ sub: "lobbies" });
    await handleLfsCommand(t.ctx, list.interaction);
    expect(list.calls.reply[0]!.content).toContain("https://discord.com/channels/g/c/msg-1");
    expect(list.calls.reply[0]!.content).toContain("1/3 crew");

    const about = fakeCommand({ sub: "about" });
    await handleLfsCommand(t.ctx, about.interaction);
    expect(about.calls.reply[0]!.content).toContain("Looking For SolMates");
  });
});
