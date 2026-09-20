import { rm } from "node:fs/promises";

// All services are foreground scoped resources; never kill a process by a stale PID or port.
await rm(".cache/media", { recursive: true, force: true });
await rm(".cache/setup.json", { force: true });
await rm(".cache/setup.json.tmp", { force: true });
console.log(
  JSON.stringify({
    status: "cleaned",
    evidence: "preserved in artifacts/",
    services:
      "Stop fixture:serve with Ctrl-C or SIGTERM; smoke closes its own resources.",
  }),
);
