import { createBot } from "./bot.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const bot = createBot(config);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`Received ${signal}, shutting down.`);
    bot.stop().finally(() => process.exit(0));
  });
}

bot.start().catch((error) => {
  console.error("Failed to start LFS:", error);
  process.exit(1);
});
