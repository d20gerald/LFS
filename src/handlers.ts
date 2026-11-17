/**
 * Interaction handlers. Thin glue between Discord, the store and the pure lobby logic.
 */
import {
  MessageFlags,
  PermissionFlagsBits,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
} from "discord.js";
import type { Config } from "./config.js";
import type { LobbyStore } from "./db.js";
import {
  close,
  expire,
  isMember,
  parseButtonId,
  tryJoin,
  tryLeave,
  validateLobbyInput,
  type Lobby,
  type Vibe,
} from "./lobby.js";
import { withLock } from "./lock.js";
import {
  buildLobbyButtons,
  buildLobbyEmbed,
  jumpLink,
  renderCrewCompleteMessage,
  renderServerDetails,
} from "./render.js";

export interface Context {
  client: Client;
  store: LobbyStore;
  config: Config;
  now: () => number;
}

const EPHEMERAL = { flags: MessageFlags.Ephemeral } as const;

function lobbyMessagePayload(lobby: Lobby) {
  return { embeds: [buildLobbyEmbed(lobby)], components: buildLobbyButtons(lobby) };
}

/** Edit the public lobby post to reflect the lobby's current state. Tolerates a deleted post. */
export async function refreshLobbyPost(ctx: Context, lobby: Lobby): Promise<void> {
  if (!lobby.messageId) return;
  try {
    const channel = await ctx.client.channels.fetch(lobby.channelId);
    if (!channel || !channel.isTextBased()) return;
    const message = await channel.messages.fetch(lobby.messageId);
    await message.edit(lobbyMessagePayload(lobby));
  } catch (error) {
    console.warn(`Could not refresh lobby #${lobby.id} post:`, (error as Error).message);
  }
}

async function announceCrewComplete(ctx: Context, lobby: Lobby): Promise<void> {
  try {
    const channel = await ctx.client.channels.fetch(lobby.channelId);
    if (!channel || !channel.isSendable()) return;
    const { content, userIds } = renderCrewCompleteMessage(lobby);
    await channel.send({ content, allowedMentions: { users: userIds } });
  } catch (error) {
    console.warn(`Could not announce crew for lobby #${lobby.id}:`, (error as Error).message);
  }
}

export async function handleLobbyCommand(ctx: Context, interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inGuild() || !interaction.guildId) {
    await interaction.reply({ ...EPHEMERAL, content: "LFS only works inside a server, not in DMs." });
    return;
  }

  if (ctx.config.allowedChannelIds.size > 0 && !ctx.config.allowedChannelIds.has(interaction.channelId)) {
    const channels = [...ctx.config.allowedChannelIds].map((id) => `<#${id}>`).join(", ");
    await interaction.reply({ ...EPHEMERAL, content: `Lobbies can only be posted in ${channels}.` });
    return;
  }

  const validation = validateLobbyInput({
    serverName: interaction.options.getString("server", true),
    password: interaction.options.getString("password"),
    vibe: interaction.options.getString("vibe", true) as Vibe,
    seats: interaction.options.getInteger("seats") ?? 4,
    juice: interaction.options.getInteger("juice") ?? 0,
    region: interaction.options.getString("region") ?? "auto",
    notes: interaction.options.getString("notes"),
  });
  if (!validation.ok) {
    await interaction.reply({ ...EPHEMERAL, content: validation.errors.map((e) => `• ${e}`).join("\n") });
    return;
  }

  const existing = ctx.store.findActiveLobbyForUser(interaction.guildId, interaction.user.id);
  if (existing) {
    const role = existing.hostId === interaction.user.id ? "hosting" : "in";
    const link = jumpLink(existing);
    await interaction.reply({
      ...EPHEMERAL,
      content: `You're already ${role} lobby #${existing.id}${link ? ` (${link})` : ""}. ${
        role === "hosting" ? "Close it" : "Leave it"
      } before posting a new one.`,
    });
    return;
  }

  const now = ctx.now();
  const lobby = ctx.store.createLobby({
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    hostId: interaction.user.id,
    input: validation.value,
    now,
    ttlMs: ctx.config.lobbyTtlMs,
  });

  const response = await interaction.reply({ ...lobbyMessagePayload(lobby), withResponse: true });
  const messageId = response.resource?.message?.id;
  if (messageId) ctx.store.setMessageId(lobby.id, messageId);

  await interaction.followUp({
    ...EPHEMERAL,
    content: [
      `Lobby #${lobby.id} is up. The server name and password stay hidden until someone clicks **Join**.`,
      validation.value.password
        ? ""
        : lobby.vibe === "tryhard"
          ? "⚠️ No password set. For a try-hard run, consider setting one in the Host screen so nobody wanders aboard uninvited."
          : "Tip: a server password keeps drive-by joiners out. Set one in the Host screen if you want.",
      "You'll get pinged here when the crew is complete. Hang tight at the Space Bar.",
    ]
      .filter(Boolean)
      .join("\n"),
  });
}

export async function handleLfsCommand(ctx: Context, interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();
  if (sub === "about") {
    await interaction.reply({
      ...EPHEMERAL,
      content: [
        "**LFS (Looking For SolMates)** helps you crew up for Sol Mates.",
        "1. In Sol Mates, pick **Play → Host**, note the server name, set a password if you like, and hit Host.",
        "2. Run `/lobby` here with that server name, your vibe, crew size, Juice level and region.",
        "3. Crewmates click **Join** to get the server details privately. You get pinged when the ship is full.",
      ].join("\n"),
    });
    return;
  }

  if (sub === "lobbies") {
    if (!interaction.guildId) {
      await interaction.reply({ ...EPHEMERAL, content: "Run this inside a server." });
      return;
    }
    const lobbies = ctx.store.listActive(interaction.guildId);
    if (lobbies.length === 0) {
      await interaction.reply({ ...EPHEMERAL, content: "No open lobbies right now. Be the host you wish to see." });
      return;
    }
    const lines = lobbies.map((l) => {
      const link = jumpLink(l);
      const where = link ? `[Lobby #${l.id}](${link})` : `Lobby #${l.id}`;
      return `• ${where}: ${l.players.length}/${l.seats} crew, ${l.vibe}, Juice ${l.juice}, host <@${l.hostId}>`;
    });
    await interaction.reply({ ...EPHEMERAL, content: lines.join("\n") });
  }
}

export async function handleButton(ctx: Context, interaction: ButtonInteraction): Promise<void> {
  const parsed = parseButtonId(interaction.customId);
  if (!parsed) return;
  const { action, lobbyId } = parsed;

  await withLock(`lobby:${lobbyId}`, async () => {
    const lobby = ctx.store.getLobby(lobbyId);
    if (!lobby) {
      await interaction.reply({ ...EPHEMERAL, content: "That lobby no longer exists." });
      return;
    }
    const userId = interaction.user.id;
    const now = ctx.now();

    switch (action) {
      case "join": {
        const elsewhere = ctx.store.findActiveLobbyForUser(lobby.guildId, userId);
        if (elsewhere && elsewhere.id !== lobby.id) {
          const link = jumpLink(elsewhere);
          await interaction.reply({
            ...EPHEMERAL,
            content: `You're already in lobby #${elsewhere.id}${link ? ` (${link})` : ""}. Leave that one first.`,
          });
          return;
        }
        const result = tryJoin(lobby, userId);
        if (result.kind === "joined") {
          ctx.store.savePlayersAndStatus(result.lobby, now);
          await interaction.update(lobbyMessagePayload(result.lobby));
          await interaction.followUp({ ...EPHEMERAL, content: `You're in! 🚀\n${renderServerDetails(result.lobby)}` });
          if (result.nowFull) await announceCrewComplete(ctx, result.lobby);
        } else if (result.kind === "already-in") {
          await interaction.reply({ ...EPHEMERAL, content: `You're already aboard.\n${renderServerDetails(lobby)}` });
        } else if (result.kind === "full") {
          await interaction.update(lobbyMessagePayload(lobby));
          await interaction.followUp({ ...EPHEMERAL, content: "That ship just filled up. Catch the next one!" });
        } else {
          await interaction.update(lobbyMessagePayload(lobby));
          await interaction.followUp({ ...EPHEMERAL, content: "That lobby is no longer open." });
        }
        return;
      }

      case "leave": {
        const result = tryLeave(lobby, userId);
        if (result.kind === "left") {
          ctx.store.savePlayersAndStatus(result.lobby, now);
          await interaction.update(lobbyMessagePayload(result.lobby));
          await interaction.followUp({ ...EPHEMERAL, content: "You've left the lobby." });
        } else if (result.kind === "host-cannot-leave") {
          await interaction.reply({ ...EPHEMERAL, content: "You're the host. Use **Close** to shut the lobby down." });
        } else if (result.kind === "not-in") {
          await interaction.reply({ ...EPHEMERAL, content: "You're not in this lobby." });
        } else {
          await interaction.update(lobbyMessagePayload(lobby));
          await interaction.followUp({ ...EPHEMERAL, content: "That lobby is no longer open." });
        }
        return;
      }

      case "details": {
        if (!isMember(lobby, userId)) {
          await interaction.reply({ ...EPHEMERAL, content: "Join the lobby first to see the server details." });
          return;
        }
        await interaction.reply({ ...EPHEMERAL, content: renderServerDetails(lobby) });
        return;
      }

      case "close": {
        const isHost = lobby.hostId === userId;
        const isMod = interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages) ?? false;
        if (!isHost && !isMod) {
          await interaction.reply({ ...EPHEMERAL, content: "Only the host (or a moderator) can close this lobby." });
          return;
        }
        if (lobby.status === "closed" || lobby.status === "expired") {
          await interaction.update(lobbyMessagePayload(lobby));
          return;
        }
        const closed = close(lobby, now);
        ctx.store.setStatus(closed.id, closed.status, closed.closedAt);
        await interaction.update(lobbyMessagePayload(closed));
        await interaction.followUp({ ...EPHEMERAL, content: `Lobby #${lobby.id} closed. Fly safe.` });
        return;
      }
    }
  });
}

/** Mark overdue lobbies expired and update their posts. Called on a timer. */
export async function sweepExpiredLobbies(ctx: Context): Promise<number> {
  const now = ctx.now();
  const overdue = ctx.store.listExpired(now);
  for (const lobby of overdue) {
    await withLock(`lobby:${lobby.id}`, async () => {
      const fresh = ctx.store.getLobby(lobby.id);
      if (!fresh || fresh.status === "closed" || fresh.status === "expired") return;
      const expired = expire(fresh, now);
      ctx.store.setStatus(expired.id, expired.status, expired.closedAt);
      await refreshLobbyPost(ctx, expired);
    });
  }
  return overdue.length;
}
