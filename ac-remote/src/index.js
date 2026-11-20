import { AuxClient, AuxError } from "./aux.js";
import { validate } from "./settings.js";
export { Schedules } from "./schedules.js";

// Per-isolate caches. Workers may recycle isolates at any time; everything here
// is rebuilt on demand (one AC Freedom login + one device listing).
let client = null;
let clientKey = "";
let deviceCache = { at: 0, list: [] };
const lastParams = new Map();

// The AC sometimes reports a room temperature of 0 between real readings;
// keep the last real value instead of showing 0°.
function remember(id, params) {
  const prev = lastParams.get(id);
  const p = { ...params };
  if (p.envtemp === 0 && prev?.envtemp) p.envtemp = prev.envtemp;
  lastParams.set(id, p);
  return p;
}

const DEVICE_TTL_MS = 5 * 60 * 1000;
const SESSION_DAYS = 30;
const COOKIE = "acr_session";

function getClient(env) {
  const key = `${env.AUX_EMAIL}|${env.AUX_PASSWORD}|${env.AUX_REGION || ""}`;
  if (!client || key !== clientKey) {
    client = new AuxClient({ email: env.AUX_EMAIL, password: env.AUX_PASSWORD, region: env.AUX_REGION });
    clientKey = key;
    deviceCache = { at: 0, list: [] };
  }
  return client;
}

async function devices(env, force = false) {
  if (force || !deviceCache.list.length || Date.now() - deviceCache.at > DEVICE_TTL_MS) {
    deviceCache = { at: Date.now(), list: await getClient(env).devices() };
  }
  return deviceCache.list;
}

async function findDevice(env, id) {
  let d = (await devices(env)).find((x) => x.endpointId === id);
  if (!d) d = (await devices(env, true)).find((x) => x.endpointId === id);
  if (!d) throw new AuxError("Device not found", null, 404);
  return d;
}

function publicDevice(d, params) {
  return {
    id: d.endpointId,
    name: d.friendlyName || d.name || "Air conditioner",
    online: !!d.online,
    params: params || null,
  };
}

// ---- App passcode auth (signed cookie) ----

const enc = new TextEncoder();
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function hmac(env, msg) {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(`acr:${env.APP_PASSCODE}:${env.SESSION_SECRET || ""}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}

async function safeEqual(a, b) {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

function readCookie(request, name) {
  const raw = request.headers.get("Cookie") || "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

async function isAuthed(request, env) {
  const token = readCookie(request, COOKIE);
  if (!token) return false;
  const [exp, sig] = token.split(".");
  if (!exp || !sig || Number(exp) < Date.now() / 1000) return false;
  return safeEqual(sig, await hmac(env, exp));
}

async function sessionCookie(env, url) {
  const exp = String(Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400);
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `${COOKIE}=${exp}.${await hmac(env, exp)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}${secure}`;
}

// ---- HTTP ----

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new AuxError("Invalid JSON body", null, 400);
  }
}

async function handleApi(request, env, url) {
  const path = url.pathname;
  const method = request.method;

  if (!env.APP_PASSCODE) return json({ error: "APP_PASSCODE secret is not set" }, 500);

  // Same-origin check for state-changing requests (defence in depth on top of SameSite).
  if (method !== "GET") {
    const origin = request.headers.get("Origin");
    if (origin && origin !== url.origin) return json({ error: "Bad origin" }, 403);
  }

  // Lets the sign-in screen unlock automatically once enough digits are typed.
  if (path === "/api/pin-length" && method === "GET") {
    return json({ length: String(env.APP_PASSCODE).length });
  }

  if (path === "/api/login" && method === "POST") {
    if (env.LOGIN_LIMITER) {
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const { success } = await env.LOGIN_LIMITER.limit({ key: `login:${ip}` });
      if (!success) return json({ error: "Too many attempts. Wait a minute, then try again." }, 429);
    }
    const { passcode } = await readJson(request);
    if (typeof passcode !== "string" || !(await safeEqual(passcode, env.APP_PASSCODE))) {
      await new Promise((r) => setTimeout(r, 800));
      return json({ error: "Wrong passcode" }, 401);
    }
    return json({ ok: true }, 200, { "Set-Cookie": await sessionCookie(env, url) });
  }

  if (path === "/api/logout" && method === "POST") {
    return json({ ok: true }, 200, { "Set-Cookie": `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` });
  }

  if (!(await isAuthed(request, env))) return json({ error: "Not signed in" }, 401);

  if (path === "/api/devices" && method === "GET") {
    const list = await devices(env, url.searchParams.has("refresh"));
    const c = getClient(env);
    const out = await Promise.all(
      list.map(async (d) => {
        if (!d.online) return publicDevice(d, null);
        try {
          const p = remember(d.endpointId, await c.getParams(d));
          return publicDevice(d, p);
        } catch {
          return { ...publicDevice(d, null), online: false };
        }
      }),
    );
    return json({ devices: out });
  }

  if (path.startsWith("/api/schedules")) {
    const stub = schedulesStub(env);
    const sm = path.match(/^\/api\/schedules(?:\/([^/]+))?$/);
    if (!sm) return json({ error: "Not found" }, 404);
    const id = sm[1] && decodeURIComponent(sm[1]);
    let r;
    if (!id && method === "GET") return json({ schedules: await stub.list() });
    if (!id && method === "POST") r = await stub.create(await readJson(request));
    else if (id && method === "PUT") r = await stub.update(id, await readJson(request));
    else if (id && method === "DELETE") r = await stub.remove(id);
    else return json({ error: "Not found" }, 404);
    return r.error ? json({ error: r.error }, r.status) : json(r.data);
  }

  const m = path.match(/^\/api\/devices\/([^/]+)$/);
  if (m) {
    const device = await findDevice(env, decodeURIComponent(m[1]));
    const c = getClient(env);
    if (method === "GET") {
      const p = remember(device.endpointId, await c.getParams(device));
      return json(publicDevice(device, p));
    }
    if (method === "POST") {
      const values = validate(await readJson(request), lastParams.get(device.endpointId));
      await c.setParams(device, values);
      const p = remember(device.endpointId, await c.getParams(device));
      return json(publicDevice(device, p));
    }
  }

  return json({ error: "Not found" }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env, url);
      } catch (err) {
        const status = err instanceof AuxError ? err.status : 500;
        console.error("API error", err?.message, err?.code);
        return json({ error: err?.message || "Server error", code: err?.code ?? null }, status);
      }
    }
    return env.ASSETS.fetch(request);
  },

  // Runs every minute (see "triggers" in wrangler.jsonc) and fires due schedules.
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      schedulesStub(env)
        .tick(controller.scheduledTime)
        .then((r) => r.ran && console.log(`Ran ${r.ran} schedule(s)`)),
    );
  },
};

function schedulesStub(env) {
  return env.SCHEDULES.get(env.SCHEDULES.idFromName("main"));
}
