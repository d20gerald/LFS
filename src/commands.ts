import { SlashCommandBuilder } from "discord.js";
import {
  MAX_JUICE,
  MAX_NOTES_LENGTH,
  MAX_PASSWORD_LENGTH,
  MAX_SEATS,
  MAX_SERVER_NAME_LENGTH,
  MIN_JUICE,
  MIN_SEATS,
  REGIONS,
  VIBES,
} from "./lobby.js";

export const lobbyCommand = new SlashCommandBuilder()
  .setName("lobby")
  .setDescription("Post a Sol Mates lobby and find a crew.")
  .addStringOption((o) =>
    o
      .setName("server")
      .setDescription("Server name from the Host screen (for example OFFE).")
      .setRequired(true)
      .setMaxLength(MAX_SERVER_NAME_LENGTH),
  )
  .addStringOption((o) =>
    o
      .setName("vibe")
      .setDescription("Casual hangout or try-hard run?")
      .setRequired(true)
      .addChoices(...VIBES.map((v) => ({ name: v.label, value: v.value }))),
  )
  .addIntegerOption((o) =>
    o
      .setName("seats")
      .setDescription(`Crew size including you (${MIN_SEATS} to ${MAX_SEATS}). Default ${MAX_SEATS}.`)
      .setMinValue(MIN_SEATS)
      .setMaxValue(MAX_SEATS),
  )
  .addIntegerOption((o) =>
    o
      .setName("juice")
      .setDescription(`Juice level (${MIN_JUICE} to ${MAX_JUICE}). Default 0.`)
      .setMinValue(MIN_JUICE)
      .setMaxValue(MAX_JUICE),
  )
  .addStringOption((o) =>
    o
      .setName("region")
      .setDescription("Region you picked on the Host screen. Default Automatic.")
      .addChoices(...REGIONS.map((r) => ({ name: r.label, value: r.value }))),
  )
  .addStringOption((o) =>
    o
      .setName("password")
      .setDescription("Server password, if you set one. Only shown to people who join.")
      .setMaxLength(MAX_PASSWORD_LENGTH),
  )
  .addStringOption((o) =>
    o
      .setName("notes")
      .setDescription("Anything else the crew should know (mic required, new players welcome, etc).")
      .setMaxLength(MAX_NOTES_LENGTH),
  );

export const lfsCommand = new SlashCommandBuilder()
  .setName("lfs")
  .setDescription("LFS utilities.")
  .addSubcommand((s) => s.setName("lobbies").setDescription("List the open lobbies on this server."))
  .addSubcommand((s) => s.setName("about").setDescription("What is LFS?"));

export const allCommands = [lobbyCommand, lfsCommand];
