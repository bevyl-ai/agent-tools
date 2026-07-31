import { afterEach, expect, test } from "bun:test";
import { displayNameOf, normalizeSlackEvent, SlackAdapter } from "./slack-adapter";
import type { RawMessage } from "./surface";

// 2026-07-14: a human message with an uploaded file arrives as subtype `file_share` — dropping it
// made the agent deaf to every screenshot-bearing ask (all file-bearing events on record were bots).
test("normalize: a human message with an uploaded file (subtype file_share) is delivered with its files", () => {
  const msg = normalizeSlackEvent(
    {
      type: "message",
      subtype: "file_share",
      ts: "100.1",
      channel: "C1",
      channel_type: "channel",
      user: "U1",
      text: "<@B1> can you write similar text for this?",
      files: [{ id: "F1", name: "shot.png", mimetype: "image/png", url_private: "https://files.slack.com/x", size: 5 }],
    },
    "B1",
  );
  expect(msg).not.toBeNull();
  expect(msg!.files).toEqual([{ id: "F1", name: "shot.png", mimetype: "image/png", urlPrivate: "https://files.slack.com/x", size: 5 }]);
  expect(msg!.mentionsBotId).toBe(true);
  expect(msg!.isBot).toBe(false);
});

test("normalize: an also-send-to-channel reply (subtype thread_broadcast) is delivered, threaded", () => {
  const msg = normalizeSlackEvent(
    { type: "message", subtype: "thread_broadcast", ts: "100.2", thread_ts: "100.1", channel: "C1", channel_type: "channel", user: "U1", text: "hi" },
    "B1",
  );
  expect(msg).not.toBeNull();
  expect(msg!.threadRootTs).toBe("100.1");
});

test("normalize: edits and other non-content subtypes stay dropped", () => {
  for (const subtype of ["message_changed", "message_deleted", "channel_join", "channel_topic"]) {
    expect(normalizeSlackEvent({ type: "message", subtype, ts: "100.3", channel: "C1", user: "U1", text: "x" }, "B1")).toBeNull();
  }
});

// A fake Slack: one Bun.serve standing in for both slack.com/api (apps.connections.open points
// the adapter at the local websocket endpoint) and the Socket Mode server itself. `pingEveryMs`
// mimics Slack's WS protocol pings; leaving it off mimics the half-open-TCP failure where a
// socket stays ESTAB but no frame (and no close) ever arrives.
function startFakeSlack(opts: { pingEveryMs?: number; roster?: Record<string, unknown>[]; userInfo?: Record<string, Record<string, unknown>> } = {}) {
  const stats = { connectionsOpened: 0, wsOpened: 0, wsClosed: 0, minLive: Infinity, usersInfoCalls: [] as string[] };
  const timers: ReturnType<typeof setInterval>[] = [];
  const live = new Set<Bun.ServerWebSocket<unknown>>();
  const server = Bun.serve({
    port: 0,
    fetch(req, srv): Response | undefined {
      const url = new URL(req.url);
      const path = url.pathname;
      if (path === "/ws") return srv.upgrade(req) ? undefined : new Response("upgrade failed", { status: 500 });
      if (path === "/api/apps.connections.open") {
        stats.connectionsOpened++;
        return Response.json({ ok: true, url: `ws://localhost:${srv.port}/ws` });
      }
      if (path === "/api/auth.test") return Response.json({ ok: true, team_id: "T1", user: "bev", url: "https://fake.slack.com/" });
      if (path === "/api/users.list") return Response.json({ ok: true, members: opts.roster ?? [] });
      if (path === "/api/users.info") {
        const id = url.searchParams.get("user") ?? "";
        stats.usersInfoCalls.push(id);
        const user = opts.userInfo?.[id];
        return user ? Response.json({ ok: true, user }) : Response.json({ ok: false, error: "user_not_found" });
      }
      return Response.json({ ok: false, error: `unexpected call: ${path}` });
    },
    websocket: {
      open(ws) {
        stats.wsOpened++;
        live.add(ws);
        if (opts.pingEveryMs) timers.push(setInterval(() => ws.ping(), opts.pingEveryMs));
      },
      message() {},
      close(ws) {
        live.delete(ws);
        stats.wsClosed++;
        stats.minLive = Math.min(stats.minLive, stats.wsOpened - stats.wsClosed);
      },
    },
  });
  let envelopeN = 0;
  return {
    stats,
    port: server.port!, // TCP serve always has one (optional in types only for unix sockets)
    // Push a message event to one live socket, the way Slack's Socket Mode delivers it.
    push(event: Record<string, unknown>) {
      const ws = [...live][0];
      if (!ws) throw new Error("no live socket to push to");
      ws.send(JSON.stringify({ type: "events_api", envelope_id: `env-${++envelopeN}`, payload: { event } }));
    },
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
    const m = String(input instanceof Request ? input.url : input).match(/^https:\/\/slack\.com\/api\/(.+)$/);
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

// 2026-07-30: the agent answered a question aimed at a teammate because its prompts carry bare
// user ids — nothing in the system knew which id was which person. Names resolve at ingestion.
test("displayNameOf: chosen display name, else real name, else handle", () => {
  expect(displayNameOf({ name: "noah.l", real_name: "Noah Lindner", profile: { display_name: "noah", real_name: "Noah Lindner" } })).toBe("noah");
  expect(displayNameOf({ name: "noah.l", profile: { display_name: "", real_name: "Noah Lindner" } })).toBe("Noah Lindner");
  expect(displayNameOf({ name: "noah.l", profile: {} })).toBe("noah.l");
  expect(displayNameOf({})).toBe("");
});

test("names: a rostered principal arrives named; an unrostered one resolves in the background for its next message", async () => {
  const fake = startFakeSlack({
    pingEveryMs: 25,
    roster: [{ id: "U_NOAH", profile: { display_name: "noah" } }],
    userInfo: { U_PEDRO: { id: "U_PEDRO", profile: { display_name: "pedro" } } },
  });
  const adapter = adapterFor(fake.port, 60_000);
  const received: RawMessage[] = [];
  adapter.onMessage((m) => received.push(m));
  const from = (user: string, ts: string) => ({ type: "message", ts, channel: "C1", channel_type: "channel", user, text: "hi" });
  try {
    await adapter.start();
    // rostered: named as soon as the users.list prewarm lands (retry rides out the startup race)
    await until(() => {
      fake.push(from("U_NOAH", `1.${received.length}`));
      return received.some((m) => m.principalName === "noah");
    });
    // unrostered: ships bare, background users.info names every later message
    fake.push(from("U_PEDRO", "2.0"));
    await until(() => received.some((m) => m.principalId === "U_PEDRO"));
    expect(received.find((m) => m.principalId === "U_PEDRO")!.principalName).toBeUndefined();
    await until(() => {
      fake.push(from("U_PEDRO", `3.${received.length}`));
      return received.some((m) => m.principalName === "pedro");
    });
    expect(fake.stats.usersInfoCalls.filter((id) => id === "U_PEDRO")).toHaveLength(1); // one in-flight lookup, no storm
    // a bot principal (B…) is never looked up — users.info can't resolve it anyway
    fake.push({ type: "message", subtype: "bot_message", bot_id: "B9", ts: "4.0", channel: "C1", channel_type: "channel", text: "alert" });
    await until(() => received.some((m) => m.principalId === "B9"));
    expect(fake.stats.usersInfoCalls).not.toContain("B9");
  } finally {
    adapter.stop();
    fake.stop();
  }
});
