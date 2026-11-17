import { Client, Events, GatewayIntentBits } from "discord.js";
import type { Config } from "./config.js";
import { LobbyStore } from "./db.js";
import { handleButton, handleLfsCommand, handleLobbyCommand, sweepExpiredLobbies, type Context } from "./handlers.js";

const SWEEP_INTERVAL_MS = 60_000;

export function createBot(config: Config): { client: Client; store: LobbyStore; start: () => Promise<void>; stop: () => Promise<void> } {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const store = new LobbyStore(config.dbPath);
  const ctx: Context = { client, store, config, now: () => Date.now() };
  let sweeper: NodeJS.Timeout | null = null;

  client.once(Events.ClientReady, (ready) => {
    console.log(`LFS online as ${ready.user.tag}. Lobbies expire after ${config.lobbyTtlMs / 60_000} minutes.`);
    sweeper = setInterval(() => {
      sweepExpiredLobbies(ctx).catch((error) => console.error("Expiry sweep failed:", error));
    }, SWEEP_INTERVAL_MS);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        if (interaction.commandName === "lobby") await handleLobbyCommand(ctx, interaction);
        else if (interaction.commandName === "lfs") await handleLfsCommand(ctx, interaction);
      } else if (interaction.isButton()) {
        await handleButton(ctx, interaction);
      }
    } catch (error) {
      console.error("Interaction failed:", error);
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction
          .reply({ content: "Something went wrong on my end. Try again in a moment.", flags: 64 })
          .catch(() => undefined);
      }
    }
  });

  return {
    client,
    store,
    start: async () => {
      await client.login(config.token);
    },
    stop: async () => {
      if (sweeper) clearInterval(sweeper);
      await client.destroy();
      store.close();
    },
  };
}
