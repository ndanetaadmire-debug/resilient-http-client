import express from "express";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { CircuitOpenError, HttpStatusError, type HttpClient } from "../../src/index.js";

/**
 * The original 5.3 Axios project, rebuilt on the resilient client.
 * What changed: query values are encoded (v1 interpolated form input into the
 * URL), responses are schema-checked, a flaky upstream is retried, a dead one
 * trips the circuit breaker, and the last good answer is served while it's down.
 */
export const activitySchema = z.object({
  activity: z.string(),
  type: z.string(),
  participants: z.number().int().positive(),
  price: z.number().min(0).max(1).optional(),
  accessibility: z.string().optional(),
  duration: z.string().optional(),
  key: z.string(),
});
export type Activity = z.infer<typeof activitySchema>;

export const TYPES = ["education", "recreational", "social", "charity", "cooking", "relaxation", "busywork"] as const;
const filterSchema = z.object({
  type: z.enum(TYPES).optional().or(z.literal("").transform(() => undefined)),
  participants: z.coerce.number().int().min(1).max(8).optional().or(z.literal("").transform(() => undefined)),
});

export function createActivityApp(
  client: HttpClient,
  options: { random?: () => number; filterCacheTtlMs?: number } = {},
) {
  const random = options.random ?? Math.random;
  const filterCacheTtlMs = options.filterCacheTtlMs ?? 60_000;
  const app = express();
  app.set("view engine", "ejs");
  app.set("views", fileURLToPath(new URL("./views", import.meta.url)));
  app.disable("x-powered-by");
  app.use(express.urlencoded({ extended: false, limit: "4kb" }));

  const render = (res: express.Response, status: number, locals: Record<string, unknown>) =>
    res.status(status).render("index", { types: TYPES, data: null, error: null, notice: null, ...locals });

  app.get("/", async (_req, res) => {
    try {
      const { data, stale } = await client.get("random", { schema: activitySchema, cacheTtlMs: 0 });
      render(res, 200, { data, notice: stale ? "Showing a saved suggestion while the activity service recovers." : null });
    } catch (err) {
      render(res, 503, { error: friendly(err) });
    }
  });

  app.post("/", async (req, res) => {
    const parsed = filterSchema.safeParse(req.body);
    if (!parsed.success) return render(res, 422, { error: "Choose a valid type and a group size from 1 to 8." });
    try {
      const { data, stale } = await client.get("filter", {
        query: { type: parsed.data.type, participants: parsed.data.participants },
        schema: z.array(activitySchema),
        cacheTtlMs: filterCacheTtlMs,
      });
      if (data.length === 0) return render(res, 404, { error: "No activities match those filters." });
      const pick = data[Math.floor(random() * data.length)];
      render(res, 200, { data: pick, notice: stale ? "Showing saved results while the activity service recovers." : null });
    } catch (err) {
      if (err instanceof HttpStatusError && err.status === 404) {
        return render(res, 404, { error: "No activities match those filters." });
      }
      render(res, 503, { error: friendly(err) });
    }
  });

  return app;
}

function friendly(err: unknown): string {
  if (err instanceof CircuitOpenError) return "The activity service is down. We've paused requests and will try again shortly.";
  return "Couldn't reach the activity service. Please try again.";
}
