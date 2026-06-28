import { createClient } from "../../src/index.js";
import { createActivityApp } from "./app.js";

const client = createClient({
  baseUrl: process.env.ACTIVITY_API ?? "https://bored-api.appbrewery.com",
  timeoutMs: 4_000,
  retry: { maxAttempts: 3 },
  breaker: { failureThreshold: 4, cooldownMs: 20_000 },
  cache: { defaultTtlMs: 0, staleIfError: true },
  events: {
    onRetry: (e) => console.warn(`retry #${e.attempt} in ${e.delayMs}ms: ${e.reason}`),
    onCircuitChange: (e) => console.warn(`circuit ${e.host}: ${e.from} -> ${e.to}`),
  },
});

const port = Number(process.env.PORT ?? 3000);
createActivityApp(client).listen(port, () => console.log(`Activity finder on http://localhost:${port}`));
