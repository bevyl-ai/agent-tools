import { afterEach, expect, test } from "bun:test";
import { SlackAdapter } from "./slack-adapter";

// A fake Slack: one Bun.serve standing in for both slack.com/api (apps.connections.open points
// the adapter at the local websocket endpoint) and the Socket Mode server itself. `pingEveryMs`
// mimics Slack's WS protocol pings; leaving it off mimics the half-open-TCP failure where a
// socket stays ESTAB but no frame (and no close) ever arrives.
function startFakeSlack(opts: { pingEveryMs?: number } = {}) {
  const stats = { connectionsOpened: 0, wsOpened: 0, wsClosed: 0, minLive: Infinity };
  const timers: ReturnType<typeof setInterval>[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req, srv): Response | undefined {
      const path = new URL(req.url).pathname;
      if (path === "/ws") return srv.upgrade(req) ? undefined : new Response("upgrade failed", { status: 500 });
      if (path === "/api/apps.connections.open") {
        stats.connectionsOpened++;
        return Response.json({ ok: true, url: `ws://localhost:${srv.port}/ws` });
      }
      if (path === "/api/auth.test") return Response.json({ ok: true, team_id: "T1", user: "bev", url: "https://fake.slack.com/" });
      return Response.json({ ok: false, error: `unexpected call: ${path}` });
    },
    websocket: {
      open(ws) {
        stats.wsOpened++;
        if (opts.pingEveryMs) timers.push(setInterval(() => ws.ping(), opts.pingEveryMs));
      },
      message() {},
      close() {
        stats.wsClosed++;
        stats.minLive = Math.min(stats.minLive, stats.wsOpened - stats.wsClosed);
      },
    },
  });
  return {
    stats,
    port: server.port!, // TCP serve always has one (optional in types only for unix sockets)
    stop() {
      for (const t of timers) clearInterval(t);
      server.stop(true);
    },
  };
}

// Route the adapter's hardcoded https://slack.com/api/* calls to the fake server.
const realFetch = globalThis.fetch;
function patchFetch(port: number): void {
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const m = String(input instanceof Request ? input.url : input).match(/^https:\/\/slack\.com\/api\/([^?]+)/);
    if (m) return realFetch(`http://localhost:${port}/api/${m[1]}`, init);
    return realFetch(input, init);
  }) as typeof fetch;
}
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function until(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
    await Bun.sleep(10);
  }
}

function adapterFor(port: number, silentAfterMs: number): SlackAdapter {
  patchFetch(port);
  return new SlackAdapter({
    botToken: "xoxb-test",
    appToken: "xapp-test",
    botUserId: "B1",
    connectionCount: 1,
    reconnectBaseMs: 1,
    reconnectMaxMs: 2,
    silentAfterMs,
  });
}

test("watchdog: a silent socket (half-open TCP, no close frame) is replaced, zero-gap", async () => {
  const fake = startFakeSlack(); // never pings — every socket goes silent immediately
  const adapter = adapterFor(fake.port, 150);
  try {
    await adapter.start();
    expect(fake.stats.wsOpened).toBe(1);
    // The watchdog notices the silence, opens a replacement, then terminates the stale socket.
    await until(() => fake.stats.connectionsOpened >= 2 && fake.stats.wsClosed >= 1);
    expect(fake.stats.wsOpened).toBeGreaterThanOrEqual(2);
    // Open-first: the pool never dipped below one live connection.
    expect(fake.stats.minLive).toBeGreaterThanOrEqual(1);
  } finally {
    adapter.stop();
    fake.stop();
  }
});

test("watchdog: a socket kept alive by WS protocol pings alone is NOT replaced", async () => {
  const fake = startFakeSlack({ pingEveryMs: 25 }); // pings only — no app-level messages, like a quiet workspace
  const adapter = adapterFor(fake.port, 150);
  try {
    await adapter.start();
    await Bun.sleep(500); // several silence-thresholds worth of wall clock
    expect(fake.stats.connectionsOpened).toBe(1);
    expect(fake.stats.wsClosed).toBe(0);
  } finally {
    adapter.stop();
    fake.stop();
  }
});
