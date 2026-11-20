import { DurableObject } from "cloudflare:workers";
import { AuxClient, AuxError } from "./aux.js";
import { validate } from "./settings.js";

// Schedules ("bookings") live in one Durable Object and are run by a
// once-a-minute cron trigger. Each schedule:
//   { id, deviceId, time: "HH:MM", days: [0..6] (0 = Sunday, empty = once),
//     tz: "Indian/Maldives", enabled, action: { pwr, ac_mode?, temp?, ac_mark? },
//     createdAt, lastRun?: "YYYY-MM-DD HH:MM", lastResult?: { at, ok, error? } }

const MAX_SCHEDULES = 40;
const CATCH_UP_MINUTES = 5; // cron can run a little late; still fire within this window
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function localParts(ms, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: tz, hourCycle: "h23", weekday: "short",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]),
  );
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hm: `${parts.hour}:${parts.minute}`, dow };
}

function validTimeZone(tz) {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return typeof tz === "string" && tz.length < 64;
  } catch {
    return false;
  }
}

export function validateSchedule(input) {
  const bad = (msg) => { throw new AuxError(msg, null, 400); };
  if (!input || typeof input !== "object") bad("Expected a schedule object");
  const { deviceId, time, days = [], tz, enabled = true, action } = input;
  if (typeof deviceId !== "string" || !deviceId) bad("Choose an air conditioner");
  if (!TIME_RE.test(time)) bad("Time must be HH:MM");
  if (!Array.isArray(days) || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) bad("Invalid repeat days");
  if (!validTimeZone(tz)) bad("Invalid time zone");
  if (!action || (action.pwr !== 0 && action.pwr !== 1)) bad("Choose turn on or turn off");

  let cleanAction = { pwr: 0 };
  if (action.pwr === 1) {
    cleanAction = { pwr: 1 };
    for (const k of ["ac_mode", "temp", "ac_mark"]) if (action[k] !== undefined) cleanAction[k] = action[k];
    validate(cleanAction); // throws a readable 400 if any value is out of range
  }
  return {
    deviceId, time, tz, enabled: !!enabled,
    days: [...new Set(days)].sort(),
    action: cleanAction,
  };
}

export class Schedules extends DurableObject {
  async #all() {
    return (await this.ctx.storage.get("schedules")) || [];
  }

  async #save(list) {
    await this.ctx.storage.put("schedules", list);
  }

  // RPC drops custom error fields, so return errors as data.
  async #safe(fn) {
    try {
      return { data: await fn() };
    } catch (err) {
      return { error: err?.message || "Schedule error", status: err?.status || 500 };
    }
  }

  async list() {
    return this.#all();
  }

  async create(input) {
    return this.#safe(async () => {
    const list = await this.#all();
    if (list.length >= MAX_SCHEDULES) throw new AuxError(`You can have up to ${MAX_SCHEDULES} schedules`, null, 400);
    const s = { id: crypto.randomUUID(), ...validateSchedule(input), createdAt: Date.now() };
    list.push(s);
    await this.#save(list);
    return s;
    });
  }

  async update(id, input) {
    return this.#safe(async () => {
    const list = await this.#all();
    const i = list.findIndex((s) => s.id === id);
    if (i < 0) throw new AuxError("Schedule not found", null, 404);
    const merged = validateSchedule({ ...list[i], ...input });
    // Editing time/days/action counts as a fresh schedule, so it can't fire for a time already passed.
    list[i] = { ...list[i], ...merged, createdAt: Date.now(), lastRun: undefined };
    await this.#save(list);
    return list[i];
    });
  }

  async remove(id) {
    return this.#safe(async () => {
    const list = await this.#all();
    await this.#save(list.filter((s) => s.id !== id));
    return { ok: true };
    });
  }

  // Called by the cron trigger every minute.
  async tick(now = Date.now()) {
    const list = await this.#all();
    const due = [];
    for (const s of list) {
      if (!s.enabled) continue;
      for (let k = 0; k < CATCH_UP_MINUTES; k++) {
        const t = now - k * 60000;
        if (t < s.createdAt - 60000) break;
        const p = localParts(t, s.tz);
        if (p.hm !== s.time) continue;
        if (s.days.length && !s.days.includes(p.dow)) continue;
        const key = `${p.date} ${p.hm}`;
        if (s.lastRun === key) break;
        due.push([s, key]);
        break;
      }
    }
    if (!due.length) return { ran: 0 };

    const client = new AuxClient({ email: this.env.AUX_EMAIL, password: this.env.AUX_PASSWORD, region: this.env.AUX_REGION });
    let devices = null;
    for (const [s, key] of due) {
      s.lastRun = key;
      try {
        devices ||= await client.devices();
        const device = devices.find((d) => d.endpointId === s.deviceId);
        if (!device) throw new AuxError("This AC is no longer on your AC Freedom account");
        await client.setParams(device, validate(s.action));
        s.lastResult = { at: now, ok: true };
      } catch (err) {
        s.lastResult = { at: now, ok: false, error: err?.message || "Unknown error" };
        console.error("Schedule failed", s.id, err?.message);
      }
      if (!s.days.length) s.enabled = false; // one-time schedules switch off after running
    }
    await this.#save(list);
    return { ran: due.length };
  }
}
