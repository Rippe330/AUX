// Minimal client for the AUX / AC Freedom cloud (BroadLink DNA platform).
// Protocol details are reverse engineered; credit to github.com/maeek/ha-aux-cloud.

const TIMESTAMP_KEY = "kdixkdqp54545^#*";
const PASSWORD_KEY = "4969fj#k23#";
const BODY_KEY = "xgx3d*fe3478$ukx";
const IV = new Uint8Array(
  [-22, -86, -86, 58, -69, 88, 98, -94, 25, 24, -75, 119, 29, 22, 21, -86].map((b) => (b + 256) % 256),
);
const LICENSE =
  "PAFbJJ3WbvDxH5vvWezXN5BujETtH/iuTtIIW5CE/SeHN7oNKqnEajgljTcL0fBQQWM0XAAAAAAnBhJyhMi7zIQMsUcwR/PEwGA3uB5HLOnr+xRrci+FwHMkUtK7v4yo0ZHa+jPvb6djelPP893k7SagmffZmOkLSOsbNs8CAqsu8HuIDs2mDQAAAAA=";
const LICENSE_ID = "3c015b249dd66ef0f11f9bef59ecd737";
const COMPANY_ID = "48eb1b36cf0202ab2ef07b880ecda60d";

export const SERVERS = {
  eu: "https://app-service-deu-f0e9ebbb.smarthomecs.de",
  usa: "https://app-service-usa-fd7cc04c.smarthomecs.com",
  rus: "https://app-service-rus-b8bbc3be.smarthomecs.com",
  cn: "https://app-service-chn-31a93883.ibroadlink.com",
};

const SESSION_EXPIRED = new Set([-30129, -1000, -1009, -1012, -3003, -49009, 10011]);
const BAD_CREDENTIALS = new Set([-1006, -1008, -1020, -1033, -1035, -1037]);
const MESSAGES = {
  "-1006": "AC Freedom email or password is incorrect",
  "-1036": "AC Freedom says requests are too frequent; wait a minute",
  "-2001": "AC Freedom says requests are too frequent; wait a minute",
};

const CONTROL = "device/control/v2/sdkcontrol";

export class AuxError extends Error {
  constructor(message, code = null, status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const enc = new TextEncoder();

async function digest(algo, text) {
  return new Uint8Array(await crypto.subtle.digest(algo, enc.encode(text)));
}
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

// AES-128-CBC with zero padding (always 1..16 bytes, like the official app).
// WebCrypto adds PKCS#7, so encrypt the zero-padded data and drop the extra final block.
export async function encryptLoginBody(json, timestamp) {
  const key = await crypto.subtle.importKey(
    "raw",
    await digest("MD5", timestamp + TIMESTAMP_KEY),
    { name: "AES-CBC" },
    false,
    ["encrypt"],
  );
  const data = enc.encode(json);
  const padded = new Uint8Array(data.length + (16 - (data.length % 16)));
  padded.set(data);
  const out = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv: IV }, key, padded));
  return out.slice(0, padded.length);
}

export async function loginToken(json) {
  return hex(await digest("MD5", json + BODY_KEY));
}

export async function hashPassword(password) {
  return hex(await digest("SHA-1", password + PASSWORD_KEY));
}

function errorCode(payload) {
  if (!payload || typeof payload !== "object") return null;
  const paths = [
    ["status"], ["code"], ["error"], ["errorCode"], ["errcode"],
    ["payload", "status"], ["payload", "code"],
    ["event", "payload", "status"], ["event", "payload", "code"],
  ];
  for (const path of paths) {
    let v = payload;
    for (const k of path) v = v && typeof v === "object" ? v[k] : undefined;
    if (v === undefined || v === null || v === 0 || v === "0") continue;
    const n = Number(v);
    if (Number.isInteger(n)) return n;
  }
  return null;
}

function parseStdData(data) {
  if (!data) return {};
  const obj = typeof data === "string" ? JSON.parse(data) : data;
  if (!obj || typeof obj !== "object") return {};
  if (!Array.isArray(obj.params) || !Array.isArray(obj.vals)) return { ...obj };
  const out = {};
  obj.params.forEach((p, i) => {
    const v = obj.vals[i]?.[0]?.val;
    if (v !== undefined) out[p] = v;
  });
  return out;
}

function decodeCookie(value) {
  try {
    let s = String(value).trim();
    s += "=".repeat((4 - (s.length % 4)) % 4);
    return JSON.parse(atob(s));
  } catch {
    return null;
  }
}

function header(namespace, name, prefix, extra = {}) {
  return {
    namespace,
    name,
    interfaceVersion: "2",
    senderId: "sdk",
    messageId: `${prefix}-${Math.floor(Date.now() / 1000)}`,
    ...extra,
  };
}

export class AuxClient {
  constructor({ email, password, region }) {
    this.email = email;
    this.password = password;
    this.region = region && SERVERS[region] ? region : null;
    this.loginsession = null;
    this.userid = null;
    this.loginPromise = null;
  }

  get base() {
    return SERVERS[this.region || "eu"];
  }

  headers(extra = {}) {
    return {
      "Content-Type": "application/x-java-serialized-object",
      licenseId: LICENSE_ID,
      lid: LICENSE_ID,
      language: "en",
      appVersion: "2.2.10.456537160",
      "User-Agent": "Dalvik/2.1.0 (Linux; U; Android 12; SM-G991B Build/SP1A.210812.016)",
      system: "android",
      appPlatform: "android",
      loginsession: this.loginsession || "",
      userid: this.userid || "",
      ...extra,
    };
  }

  async raw(base, endpoint, { body, headers, params } = {}) {
    const url = new URL(`${base}/${endpoint}`);
    for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
    let res;
    try {
      res = await fetch(url, { method: "POST", headers: this.headers(headers), body });
    } catch (err) {
      throw new AuxError(`Could not reach AC Freedom cloud (${err.message})`, null, 504);
    }
    const text = await res.text();
    if (res.status === 429) throw new AuxError(MESSAGES["-1036"], 429, 429);
    if (!res.ok) throw new AuxError(`AC Freedom cloud returned HTTP ${res.status}`, res.status);
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      throw new AuxError("AC Freedom cloud returned an unreadable response");
    }
  }

  async login() {
    // Single-flight: concurrent requests share one login.
    if (!this.loginPromise) {
      this.loginPromise = this.#login().finally(() => (this.loginPromise = null));
    }
    return this.loginPromise;
  }

  async #login() {
    if (!this.email || !this.password) {
      throw new AuxError("AUX_EMAIL and AUX_PASSWORD secrets are not set", null, 500);
    }
    const json = JSON.stringify({
      email: this.email,
      password: await hashPassword(this.password),
      companyid: COMPANY_ID,
      lid: LICENSE_ID,
    });
    const token = await loginToken(json);
    const regions = this.region ? [this.region] : Object.keys(SERVERS);
    let lastError;
    for (const region of regions) {
      const timestamp = String(Date.now() / 1000);
      const body = await encryptLoginBody(json, timestamp);
      this.loginsession = null;
      this.userid = null;
      let data;
      try {
        data = await this.raw(SERVERS[region], "account/login", { body, headers: { timestamp, token } });
      } catch (err) {
        lastError = err;
        continue;
      }
      const code = errorCode(data);
      if (code === null && typeof data.loginsession === "string") {
        this.region = region;
        this.loginsession = data.loginsession;
        this.userid = data.userid;
        return;
      }
      lastError = BAD_CREDENTIALS.has(code)
        ? new AuxError("AC Freedom email or password is incorrect (check the AUX_EMAIL / AUX_PASSWORD secrets)", code, 502)
        : new AuxError(MESSAGES[String(code)] || `AC Freedom login failed (code ${code})`, code, 502);
      // An unknown account in one region is normal while auto-detecting; try the next.
    }
    throw lastError;
  }

  async request(endpoint, opts = {}, retry = true) {
    if (!this.loginsession) await this.login();
    const data = await this.raw(this.base, endpoint, opts);
    const code = errorCode(data);
    if (code === null) return data;
    if (retry && SESSION_EXPIRED.has(code)) {
      this.loginsession = null;
      await this.login();
      return this.request(endpoint, opts, false);
    }
    throw new AuxError(MESSAGES[String(code)] || `AC Freedom error (code ${code})`, code);
  }

  async families() {
    const data = await this.request("appsync/group/member/getfamilylist");
    return data?.data?.familyList || [];
  }

  async devices() {
    const families = await this.families();
    const lists = await Promise.all(
      families.flatMap((f) => [
        this.request("appsync/group/dev/query?action=select", {
          body: '{"pids":[]}',
          headers: { familyid: f.familyid },
        }).then((d) => (d?.data?.endpoints || []).map((dev) => ({ ...dev, familyId: f.familyid }))),
        this.request("appsync/group/sharedev/querylist?querytype=shared", {
          body: '{"endpointId":""}',
          headers: { familyid: f.familyid },
        })
          .then((d) => (d?.data?.shareFromOther || []).map((s) => ({ ...s.devinfo, familyId: f.familyid })))
          .catch(() => []),
      ]),
    );
    const seen = new Set();
    const devices = lists.flat().filter((d) => d?.endpointId && !seen.has(d.endpointId) && seen.add(d.endpointId));
    if (devices.length) {
      const states = await this.queryStates(devices);
      for (const d of devices) d.online = states[d.endpointId] === 1;
    }
    return devices;
  }

  async queryStates(devices) {
    const data = await this.request("device/control/v2/querystate", {
      body: JSON.stringify({
        directive: {
          header: header("DNA.QueryState", "queryState", this.userid || "", { messageType: "controlgw.batch" }),
          payload: {
            studata: devices.map((d) => ({ did: d.endpointId, devSession: d.devSession })),
            msgtype: "batch",
          },
        },
      }),
    });
    const out = {};
    for (const s of data?.event?.payload?.data || []) out[s.did] = s.state;
    return out;
  }

  directive(device, act, params = [], vals = []) {
    const cookie = decodeCookie(device.cookie);
    if (!cookie?.terminalid || !cookie?.aeskey) {
      throw new AuxError("Device record is missing control metadata");
    }
    const mapped = btoa(
      JSON.stringify({
        device: {
          id: cookie.terminalid,
          key: cookie.aeskey,
          devSession: device.devSession,
          aeskey: cookie.aeskey,
          did: device.endpointId,
          pid: device.productId,
          mac: device.mac,
        },
      }),
    );
    const now = String(Math.floor(Date.now() / 1000));
    return {
      header: header("DNA.KeyValueControl", "KeyValueControl", device.endpointId, { timstamp: now }),
      endpoint: {
        devicePairedInfo: {
          did: device.endpointId,
          pid: device.productId,
          mac: device.mac,
          devicetypeflag: device.devicetypeFlag,
          cookie: mapped,
        },
        endpointId: device.endpointId,
        cookie: {},
        devSession: device.devSession,
      },
      // A single-parameter GET needs a placeholder value, like the official app sends.
      payload: {
        act, params, did: device.endpointId,
        vals: act === "get" && params.length === 1 ? [[{ val: 0, idx: 1 }]] : vals,
      },
    };
  }

  async control(device, act, params, vals) {
    const data = await this.request(CONTROL, {
      body: JSON.stringify({ directive: this.directive(device, act, params, vals) }),
      params: { license: LICENSE },
    });
    const event = data?.event;
    if (!event || event.header?.name !== "Response") {
      throw new AuxError("Unexpected response from the AC (is it online?)");
    }
    return parseStdData(event.payload?.data);
  }

  // The full status often leaves out the room temperature ("envtemp"); AC Freedom
  // returns it for a separate query of the special "mode" parameter, so ask for both.
  async getParams(device) {
    const [main, extra] = await Promise.all([
      this.control(device, "get", [], []),
      this.control(device, "get", ["mode"], []).catch(() => ({})),
    ]);
    const merged = { ...main };
    if (typeof extra.envtemp === "number") merged.envtemp = extra.envtemp;
    return merged;
  }

  setParams(device, values) {
    const params = Object.keys(values);
    const vals = params.map((k) => [{ idx: 1, val: values[k] }]);
    return this.control(device, "set", params, vals);
  }
}
