import { json } from "./util";

/**
 * Authenticate a call from our analysis worker (ml/): a bearer token equal to
 * ANALYSIS_WORKER_SECRET. Returns an error response to send back, or null when
 * the caller is the worker. Fails closed while the secret is unset.
 */
export function workerAuthError(req: Request, route: string): Response | null {
  const secret = process.env.ANALYSIS_WORKER_SECRET;
  if (!secret) {
    console.error(`[${route}] ANALYSIS_WORKER_SECRET is not set — refusing`);
    return json({ error: "Not configured." }, { status: 503 });
  }
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return json({ error: "Unauthorized." }, { status: 401 });
  }
  return null;
}
