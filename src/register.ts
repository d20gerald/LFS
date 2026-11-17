/**
 * Registers the slash commands with Discord. Run once after install, and again
 * whenever the command definitions in commands.ts change.
 */
import { REST, Routes } from "discord.js";
import { allCommands } from "./commands.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const rest = new REST().setToken(config.token);
const body = allCommands.map((c) => c.toJSON());

const route = config.guildId
  ? Routes.applicationGuildCommands(config.clientId, config.guildId)
  : Routes.applicationCommands(config.clientId);

const result = (await rest.put(route, { body })) as unknown[];
console.log(
  `Registered ${result.length} command(s) ${config.guildId ? `to guild ${config.guildId}` : "globally"}.`,
);
