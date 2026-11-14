import { hostedConfiguration } from "./hosted-config.ts";
import { startHostedAdapter } from "./hosted.ts";

async function main() {
  const server = await startHostedAdapter(hostedConfiguration(process.env));
  console.log("Hosted adapter ready.");
  try {
    await new Promise<void>((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
  } finally {
    await server.close();
  }
}
main().catch(() => {
  console.error("Hosted adapter failed. Check private runtime configuration.");
  process.exitCode = 1;
});
