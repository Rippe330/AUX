import { AuxError } from "./aux.js";

// Writable settings: name -> allowed integer values.
const BOOL = [0, 1];
export const WRITABLE = {
  pwr: BOOL,
  ac_mode: [0, 1, 2, 3, 4], // cool, heat, dry, fan, auto
  ac_mark: [0, 1, 2, 3, 4, 5, 6, 7], // auto, low, mid, high, turbo, silent, mid-low, mid-high
  ac_vdir: BOOL,
  ac_hdir: BOOL,
  ecomode: BOOL,
  ac_slp: BOOL,
  scrdisp: BOOL,
  ac_health: BOOL,
  ac_clean: BOOL,
  comfwind: BOOL,
  mldprf: BOOL,
  ac_astheat: BOOL,
  childlock: BOOL,
};

// Temperature is sent as tenths of a degree Celsius. Units set to Fahrenheit
// on the AC use AC Freedom's split encoding.
export function encodeTemperature(celsius, current = {}) {
  const x10 = Math.round(celsius * 10);
  if (current.tempunit === 2) {
    const base = Math.floor(x10 / 10) * 10;
    return { temp: base, tempunit: 2, ac_tempdec: 0, ac_tempconvert: x10 - base };
  }
  return { temp: x10 };
}

export function validate(body, current) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new AuxError("Expected a JSON object of settings", null, 400);
  }
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    if (k === "temp") {
      const t = Number(v);
      if (!Number.isFinite(t) || t < 16 || t > 32) throw new AuxError("temp must be 16–32 °C", null, 400);
      Object.assign(out, encodeTemperature(t, current));
    } else if (WRITABLE[k]) {
      if (!WRITABLE[k].includes(v)) throw new AuxError(`Invalid value for ${k}`, null, 400);
      out[k] = v;
    } else {
      throw new AuxError(`Unknown setting: ${k}`, null, 400);
    }
  }
  if (!Object.keys(out).length) throw new AuxError("No settings given", null, 400);
  return out;
}

