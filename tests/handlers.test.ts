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
  editReply: Payload[];
}

function fakeCommand(opts: {
  guildId?: string | null;
  channelId?: string;
  userId?: string;
  strings?: Record<string, string | null>;
  ints?: Record<string, number | null>;
  sub?: string;
} = {}) {
  const calls: Calls = { reply: [], followUp: [], update: [], editReply: [] };
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
  const calls: Calls = { reply: [], followUp: [], update: [], editReply: [] };
  const interaction = {
    customId,
    user: { id: userId },
    memberPermissions: { has: () => opts.manageMessages ?? false },
    reply: async (payload: Payload) => {
      calls.reply.push(payload);
    },
    editReply: async (payload: Payload) => {
      calls.editReply.push(payload);
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

/** A guild fake that records voice-channel traffic: creations, overwrite updates and deletions. */
interface Overwrite {
  id: string;
  allow?: bigint[];
  deny?: bigint[];
}
interface FakeGuildChannel {
  id: string;
  name: string;
  type: number;
  parent: string | null;
  userLimit?: number;
  overwrites: Overwrite[];
  deleted: boolean;
}
function fakeGuild(opts: { botPermissions?: boolean; categories?: Array<{ id: string; name: string }> } = {}) {
  const channels = new Map<string, FakeGuildChannel>();
  const CATEGORY = 4;
  const VOICE = 2;
  for (const c of opts.categories ?? []) {
    channels.set(c.id, { id: c.id, name: c.name, type: CATEGORY, parent: null, overwrites: [], deleted: false });
  }
  let nextId = 100;
  const wrap = (c: FakeGuildChannel) => ({
    id: c.id,
    name: c.name,
    type: c.type,
    permissionOverwrites: {
      set: async (overwrites: Overwrite[]) => {
        c.overwrites = overwrites;
      },
    },
    delete: async () => {
      c.deleted = true;
      channels.delete(c.id);
    },
  });
  const guild = {
    id: "g",
    members: { fetchMe: async () => ({ id: "bot", permissions: { has: () => opts.botPermissions ?? true } }) },
    channels: {
      fetch: async (id?: string) => {
        if (id === undefined) return new Map([...channels].map(([k, v]) => [k, wrap(v)]));
        const c = channels.get(id);
        if (!c) throw new Error("Unknown Channel");
        return wrap(c);
      },
      create: async (o: { name: string; type: number; parent?: string | null; userLimit?: number; permissionOverwrites?: Overwrite[] }) => {
        const c: FakeGuildChannel = {
          id: `ch-${nextId++}`,
          name: o.name,
          type: o.type,
          parent: o.parent ?? null,
          overwrites: o.permissionOverwrites ?? [],
          deleted: false,
          ...(o.userLimit !== undefined ? { userLimit: o.userLimit } : {}),
        };
        channels.set(c.id, c);
        return wrap(c);
      },
    },
  };
  return {
    guild,
    channels,
    voiceRooms: () => [...channels.values()].filter((c) => c.type === VOICE),
    categories: () => [...channels.values()].filter((c) => c.type === CATEGORY),
  };
}

function fakeClient(guildOpts?: Parameters<typeof fakeGuild>[0]) {
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
  const g = fakeGuild(guildOpts);
  const client = {
    channels: { fetch: async () => channel },
    guilds: { fetch: async () => g.guild },
  } as unknown as Client;
  return { client, sent, edits, guild: g };
}

function makeContext(overrides: Partial<Config> = {}, guildOpts?: Parameters<typeof fakeGuild>[0]) {
  const { client, sent, edits, guild } = fakeClient(guildOpts);
  const store = new LobbyStore(":memory:");
  const config: Config = {
    token: "t",
    clientId: "app",
    guildId: null,
    allowedChannelIds: new Set(),
    lobbyTtlMs: 90 * 60_000,
    dbPath: ":memory:",
    voiceRooms: true,
    voiceCategoryId: null,
    voiceCategoryName: "LFS Voice",
    ...overrides,
  };
  let now = NOW;
  const ctx: Context = { client, store, config, now: () => now };
  return { ctx, store, sent, edits, guild, setNow: (t: number) => (now = t) };
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
    // Two follow-ups: the private server details, then the public "comms are open" note.
    expect(btn.calls.followUp).toHaveLength(2);
    expect(btn.calls.followUp[0]!.flags).toBe(64);
    expect(btn.calls.followUp[1]!.flags).toBeUndefined();
  });

  it("pings the host and crew when the last seat fills", async () => {
    await handleButton(t.ctx, fakeButton(buttonId("join", lobby.id), "a").interaction);
    const last = fakeButton(buttonId("join", lobby.id), "b");
    await handleButton(t.ctx, last.interaction);
    expect(t.store.getLobby(lobby.id)?.status).toBe("full");
    const announcement = last.calls.followUp[1]!;
    expect(announcement.content).toContain("<@host> your crew is complete: <@a>, <@b>");
    expect(announcement.flags).toBeUndefined();
    expect(announcement.allowedMentions).toEqual({ users: ["host", "a", "b"] });
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
    const announcements = [...b.calls.followUp, ...c.calls.followUp].filter((f) => f.content?.includes("crew is complete"));
    expect(announcements).toHaveLength(1);
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

describe("crew voice rooms", () => {
  const VOICE = 2;
  const allowedIds = (overwrites: Overwrite[]) => overwrites.filter((o) => (o.allow?.length ?? 0) > 0).map((o) => o.id);

  it("opens a crew-only room under a fresh LFS Voice category when the first crewmate joins", async () => {
    const t = makeContext();
    const lobby = (await postLobby(t.ctx)).lobby!;
    expect(t.guild.voiceRooms()).toHaveLength(0);

    const btn = fakeButton(buttonId("join", lobby.id), "a");
    await handleButton(t.ctx, btn.interaction);

    const rooms = t.guild.voiceRooms();
    expect(rooms).toHaveLength(1);
    const room = rooms[0]!;
    expect(room.name).toBe(`LFS Crew #${lobby.id}`);
    expect(room.userLimit).toBe(3);
    expect(t.guild.categories().map((c) => c.name)).toEqual(["LFS Voice"]);
    expect(room.parent).toBe(t.guild.categories()[0]!.id);
    expect(room.overwrites.find((o) => o.id === "g")?.deny?.length).toBeGreaterThan(0);
    expect(allowedIds(room.overwrites)).toEqual(["bot", "host", "a"]);

    expect(t.store.getLobby(lobby.id)?.voiceChannelId).toBe(room.id);
    expect(JSON.stringify(btn.calls.editReply[0]!.embeds)).toContain(`<#${room.id}>`);
    expect(btn.calls.followUp[0]!.content).toContain(`Voice chat: <#${room.id}>`);
    const note = btn.calls.followUp[1]!;
    expect(note.content).toContain(`<@host> comms are open: <#${room.id}>`);
    expect(note.allowedMentions).toEqual({ users: ["host"] });
    expect(note.flags).toBeUndefined();
  });

  it("reuses an existing category and keeps the room's member list in step with the crew", async () => {
    const t = makeContext({}, { categories: [{ id: "cat-1", name: "lfs voice" }] });
    const lobby = (await postLobby(t.ctx)).lobby!;
    await handleButton(t.ctx, fakeButton(buttonId("join", lobby.id), "a").interaction);
    const room = t.guild.voiceRooms()[0]!;
    expect(room.parent).toBe("cat-1");
    expect(t.guild.categories()).toHaveLength(1);

    const last = fakeButton(buttonId("join", lobby.id), "b");
    await handleButton(t.ctx, last.interaction);
    expect(t.guild.voiceRooms()).toHaveLength(1);
    expect(allowedIds(room.overwrites)).toEqual(["bot", "host", "a", "b"]);
    expect(last.calls.followUp[1]!.content).toContain(`Comms are open in <#${room.id}>`);
    expect(last.calls.followUp).toHaveLength(2);

    await handleButton(t.ctx, fakeButton(buttonId("leave", lobby.id), "a").interaction);
    expect(allowedIds(room.overwrites)).toEqual(["bot", "host", "b"]);
    expect(t.guild.voiceRooms()).toHaveLength(1);
  });

  it("honors an explicit category id", async () => {
    const t = makeContext({ voiceCategoryId: "cat-9" }, { categories: [{ id: "cat-9", name: "Whatever" }] });
    const lobby = (await postLobby(t.ctx)).lobby!;
    await handleButton(t.ctx, fakeButton(buttonId("join", lobby.id), "a").interaction);
    expect(t.guild.voiceRooms()[0]!.parent).toBe("cat-9");
    expect(t.guild.categories()).toHaveLength(1);
  });

  it("deletes the room when the host closes the lobby", async () => {
    const t = makeContext();
    const lobby = (await postLobby(t.ctx)).lobby!;
    await handleButton(t.ctx, fakeButton(buttonId("join", lobby.id), "a").interaction);
    const room = t.guild.voiceRooms()[0]!;
    await handleButton(t.ctx, fakeButton(buttonId("close", lobby.id), "host").interaction);
    expect(room.deleted).toBe(true);
    expect(t.guild.voiceRooms()).toHaveLength(0);
    expect(t.store.getLobby(lobby.id)?.voiceChannelId).toBeNull();
  });

  it("deletes the room when the lobby expires", async () => {
    const t = makeContext({ lobbyTtlMs: 1000 });
    const lobby = (await postLobby(t.ctx)).lobby!;
    await handleButton(t.ctx, fakeButton(buttonId("join", lobby.id), "a").interaction);
    expect(t.guild.voiceRooms()).toHaveLength(1);
    t.setNow(NOW + 1000);
    await sweepExpiredLobbies(t.ctx);
    expect(t.guild.voiceRooms()).toHaveLength(0);
    expect(t.store.getLobby(lobby.id)?.voiceChannelId).toBeNull();
  });

  it("makes a new room if someone deleted the old one by hand", async () => {
    const t = makeContext();
    const lobby = (await postLobby(t.ctx)).lobby!;
    await handleButton(t.ctx, fakeButton(buttonId("join", lobby.id), "a").interaction);
    const first = t.guild.voiceRooms()[0]!;
    t.guild.channels.delete(first.id);

    await handleButton(t.ctx, fakeButton(buttonId("join", lobby.id), "b").interaction);
    const rooms = t.guild.voiceRooms();
    expect(rooms).toHaveLength(1);
    expect(rooms[0]!.id).not.toBe(first.id);
    expect(t.store.getLobby(lobby.id)?.voiceChannelId).toBe(rooms[0]!.id);
  });

  it("carries on without a room when the bot lacks permissions", async () => {
    const t = makeContext({}, { botPermissions: false });
    const lobby = (await postLobby(t.ctx)).lobby!;
    const btn = fakeButton(buttonId("join", lobby.id), "a");
    await handleButton(t.ctx, btn.interaction);
    expect(t.guild.voiceRooms()).toHaveLength(0);
    expect(t.store.getLobby(lobby.id)).toMatchObject({ players: ["host", "a"], voiceChannelId: null });
    expect(btn.calls.editReply).toHaveLength(0);
    expect(btn.calls.followUp).toHaveLength(1);
    expect(btn.calls.followUp[0]!.content).not.toContain("Voice chat");
  });

  it("stays off when LFS_VOICE_ROOMS is off", async () => {
    const t = makeContext({ voiceRooms: false });
    const lobby = (await postLobby(t.ctx)).lobby!;
    await handleButton(t.ctx, fakeButton(buttonId("join", lobby.id), "a").interaction);
    expect(t.guild.voiceRooms()).toHaveLength(0);
    expect(t.guild.categories()).toHaveLength(0);
  });

  it("does not create a room for a lonely host", async () => {
    const t = makeContext();
    await postLobby(t.ctx);
    expect(t.guild.voiceRooms()).toHaveLength(0);
    expect(t.guild.voiceRooms().filter((r) => r.type === VOICE)).toHaveLength(0);
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
