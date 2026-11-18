/**
 * Issue #147: the Agenda, time-of-day and twilight triggers that run a sequence, macro, plugin or command.
 *
 *   gma3_agenda        read the agenda entries, whether the agenda runs, and the location twilight times use
 *   gma3_store_agenda  create (or with overwrite: replace) entries; a batch form takes a list
 *
 * Built on existing bridge ops only (no bridge change): `object` (the Agendas collection with its entries, an entry's
 * properties and property schema, the station's TimeConfig), `objects` (an entry and a target by command-line
 * reference, the entry's Object as a handle), `set` (one property) and `cmd` (Store, Delete, Assign).
 *
 * Console facts (onPC 2.5.1, read-only probe of Festoon Demo 2026-11-17, and the 2.5 manual pages Agenda, Create an
 * Agenda Entry, Agenda keyword, Date and Time):
 *   - The entries live in ShowData.Agendas (class Agendas, address 14.16), whose Running property says whether the
 *     agenda runs. The Agenda keyword addresses one entry: "Assign Sequence 1 At Agenda 1", "Label Agenda 1 ...",
 *     'Set Agenda 2 Property "Mode" "Dawn"'.
 *   - An entry (class AgendaEvent) has a Mode (Absolute, or the twilight times Dawn, Sunrise, Sunset, Dusk), a start
 *     date and time, a daylight offset (a twilight entry's distance from that time), a valid duration (how long a
 *     missed entry may still fire), Enabled, an Object (plugin, macro or sequence) with an Action, or a Command, and a
 *     repeat: an end date or time, a minute interval, day, week and month patterns, and repeat every year. The planned
 *     date and time of the next firing are read-only. The probe show had no entry, so the exact property names are
 *     not known: they are taken from an entry's property schema (another entry's before anything is sent, or the new
 *     entry's), matched against the names the onPC binary carries (StartDate, StartTime, EndDate, EndTime,
 *     MinuteInterval, RepeatEveryYear, AgendaMode), and an entry whose schema lacks a property the request needs is
 *     refused (or, when only the new entry could tell, deleted again).
 *   - Twilight times are calculated for the location in Root.StationSettings.TimeConfig (Latitude, Longitude,
 *     TimeZone). The probe console still had the factory location, latitude 49.7878 and longitude 9.9361 (MA
 *     Lighting's home town) with time zone UTC-6, so its sunset read 09:34 local time: a twilight entry there fires
 *     at the wrong time. The tools report the location and warn while it is the factory one.
 *   - A new entry starts with the console's date and time. It is disabled first, configured, and enabled last, so a
 *     half-configured entry cannot fire.
 *
 * Not verified on a console (the probe could not create an entry): the property names above, the form Set() takes
 * for dates (DD.MM.YYYY is sent), times (HH:MM:SS) and the offset and duration (seconds), the Action names, the
 * Store Agenda command, and whether an end date alone repeats the entry every day. Every value is read back, so a
 * form the console does not take shows as a mismatch, never as a success.
 */
import { z } from "zod";
import type { Gma3Bridge } from "../bridge.js";
import { BATCH_NOTE, batchOptionShape, duplicates, runBatchCall } from "../batch.js";
import { asRead, buildResult, commandStep, requestStep, stepFromError, timeToSeconds, validationFailure, type OperationResult, type StepResult, type Verification } from "../results.js";
import { ValidationError, describe, objectName, quoteName } from "../validate.js";
import { isNotFoundError, readObjects } from "./common.js";
import { json, operation, type RegisterTools, type ToolContext } from "./context.js";

export const AGENDA_MODES = ["absolute", "dawn", "sunrise", "sunset", "dusk"] as const;
export type AgendaMode = (typeof AGENDA_MODES)[number];
const MODE_TEXT: Record<AgendaMode, string> = { absolute: "Absolute", dawn: "Dawn", sunrise: "Sunrise", sunset: "Sunset", dusk: "Dusk" };

const MAX_NO = 9999;
const AGENDAS = "ShowData.Agendas";
const TIME_CONFIG = "Root.StationSettings.TimeConfig";
/** The factory location (MA Lighting, Waldbüttelbrunn): twilight times there are not the show's. */
const FACTORY_LOCATION = { latitude: 49.7878, longitude: 9.9361 };

/** The entry properties the tools use, by role, with the names they may have (first match wins, any case). */
export const AGENDA_PROPS = {
  name: ["NAME"],
  mode: ["MODE", "AGENDAMODE"],
  date: ["STARTDATE", "DATE"],
  time: ["STARTTIME", "TIME"],
  offset: ["DAYLIGHTOFFSET", "OFFSET", "TWILIGHTOFFSET"],
  validDuration: ["VALIDDURATION", "DURATION"],
  enabled: ["ENABLED", "ENABLE"],
  object: ["OBJECT"],
  action: ["ACTION"],
  command: ["COMMAND", "CMD"],
  untilDate: ["ENDDATE"],
  untilTime: ["ENDTIME"],
  everyMinutes: ["MINUTEINTERVAL"],
  everyYear: ["REPEATEVERYYEAR", "EVERYYEAR"],
  plannedDate: ["PLANNEDDATE"],
  plannedTime: ["PLANNEDTIME"],
  countdown: ["COUNTDOWN"],
} as const;
export type AgendaRole = keyof typeof AGENDA_PROPS;

/** The property name for a role among the names an entry has, or undefined. */
export function propFor(names: Iterable<string>, role: AgendaRole): string | undefined {
  const upper = new Map<string, string>();
  for (const n of names) upper.set(n.toUpperCase(), n);
  for (const c of AGENDA_PROPS[role]) {
    const hit = upper.get(c);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Parsing and formats
// ---------------------------------------------------------------------------

/** "2026-12-24" checked as a calendar date. */
export function isoDate(field: string, value: unknown): string {
  if (typeof value !== "string") throw new ValidationError(`${field} must be a date "YYYY-MM-DD" (got ${describe(value)})`, field);
  const m = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new ValidationError(`${field} must be a date "YYYY-MM-DD" (got ${JSON.stringify(value)})`, field);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d || y < 1970 || y > 2099) {
    throw new ValidationError(`${field} ${JSON.stringify(value)} is not a calendar date between 1970 and 2099`, field);
  }
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** "19:30" or "19:30:15" as seconds of the day. */
export function clockSeconds(field: string, value: unknown): number {
  if (typeof value !== "string") throw new ValidationError(`${field} must be a time "HH:MM" or "HH:MM:SS" (got ${describe(value)})`, field);
  const m = value.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59 || Number(m[3] ?? 0) > 59) {
    throw new ValidationError(`${field} must be a time "HH:MM" or "HH:MM:SS", 00:00 to 23:59:59 (got ${JSON.stringify(value)})`, field);
  }
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] ?? 0);
}

const pad = (n: number) => String(n).padStart(2, "0");
/** The form sent to the console: DD.MM.YYYY (the console's own date text, TimeConfig's LocalTime). */
export const consoleDate = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
export const consoleTime = (s: number) => `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;

/**
 * A date as the console reads it: "24.12.2026", "2026-12-24", or "12/24/2026". A slash date whose day and month
 * could swap is ambiguous and gives both readings.
 */
export function parseConsoleDate(v: unknown): { iso: string } | { ambiguous: string[] } | null {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  const iso = (y: string, mo: number, d: number) => `${y}-${pad(mo)}-${pad(d)}`;
  let m = t.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})\b/);
  if (m) return { iso: iso(m[3], Number(m[2]), Number(m[1])) };
  m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (m) return { iso: iso(m[1], Number(m[2]), Number(m[3])) };
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a > 12) return { iso: iso(m[3], b, a) };
    if (b > 12 || a === b) return { iso: iso(m[3], a, b) };
    return { ambiguous: [iso(m[3], a, b), iso(m[3], b, a)] };
  }
  return null;
}

/** A clock time as the console reads it ("19:30:00", "19:30", "19h30m00.00") in seconds of the day. */
export function parseConsoleClock(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  const m = t.match(/^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/);
  if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] ?? 0);
  const s = timeToSeconds(t);
  return s === null ? null : Math.round(s);
}

/** A signed duration as the console reads it ("-15m00.00", "-900", "00:15:00", "1h") in seconds. */
export function parseSignedSeconds(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (v === null || v === undefined) return null;
  let t = String(v).trim();
  let sign = 1;
  if (t.startsWith("-")) {
    sign = -1;
    t = t.slice(1).trim();
  } else if (t.startsWith("+")) t = t.slice(1).trim();
  const hms = t.match(/^(\d+):(\d{2})(?::(\d{2}(?:\.\d+)?))?$/);
  if (hms) return sign * (Number(hms[1]) * 3600 + Number(hms[2]) * 60 + Number(hms[3] ?? 0));
  const s = timeToSeconds(t);
  return s === null ? null : sign * s;
}

const yesNo = (v: unknown): boolean | null => {
  const t = String(v ?? "").trim().toLowerCase();
  if (/^(yes|on|true|1)$/.test(t)) return true;
  if (/^(no|off|false|0)$/.test(t)) return false;
  return null;
};

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

interface ObjectRead {
  properties?: Record<string, unknown>;
  schema?: Array<{ name: string; readOnly?: boolean; enum?: string; type?: string }>;
  children?: { items?: Array<{ addr?: string; name?: string; class?: string; fields?: Record<string, unknown>; fieldErrors?: Record<string, unknown> }>; total?: number; enumerationError?: string };
  class?: string;
  addr?: string;
  name?: string;
}

const readObject = async (bridge: Gma3Bridge, ref: string, extra: Record<string, unknown> = {}, t?: number): Promise<ObjectRead> =>
  (await bridge.request("object", { ref, ...extra }, t)) as ObjectRead;

export interface AgendaSlot {
  no: number;
  name?: string;
  addr?: string;
}

/** The Agendas collection: whether it runs and its entries (number, name, address). */
export async function readAgendas(bridge: Gma3Bridge, t?: number): Promise<{ running: boolean | null; slots: AgendaSlot[]; complete: boolean; error?: string }> {
  const res = await readObject(bridge, AGENDAS, { children: true, childFields: ["No", "Name"], childLimit: 1000 }, t);
  const props = res.properties ?? {};
  const running = yesNo(props.RUNNING ?? props.Running);
  const items = res.children?.items ?? [];
  const slots: AgendaSlot[] = [];
  let complete = !res.children?.enumerationError && (res.children?.total === undefined || res.children.total <= items.length);
  for (const it of items) {
    const no = Number(it.fields?.No);
    if (!Number.isInteger(no) || it.fieldErrors?.No !== undefined) {
      complete = false;
      continue;
    }
    slots.push({ no, name: typeof it.fields?.Name === "string" ? it.fields.Name : it.name, addr: it.addr });
  }
  return { running, slots, complete, ...(res.children?.enumerationError ? { error: String(res.children.enumerationError) } : {}) };
}

export interface Location {
  latitude: number | null;
  longitude: number | null;
  timeZone: unknown;
  factory: boolean;
  today: { dawn: unknown; sunrise: unknown; sunset: unknown; dusk: unknown };
  localTime: unknown;
}

/** The location twilight entries use, and today's twilight times. */
export async function readLocation(bridge: Gma3Bridge, t?: number): Promise<Location> {
  const p = (await readObject(bridge, TIME_CONFIG, {}, t)).properties ?? {};
  const num = (v: unknown) => (v === undefined || v === null || String(v).trim() === "" ? null : Number(v));
  const latitude = num(p.LATITUDE);
  const longitude = num(p.LONGITUDE);
  const factory =
    latitude !== null && longitude !== null && Math.abs(latitude - FACTORY_LOCATION.latitude) < 0.001 && Math.abs(longitude - FACTORY_LOCATION.longitude) < 0.001;
  return {
    latitude: Number.isFinite(latitude) ? latitude : null,
    longitude: Number.isFinite(longitude) ? longitude : null,
    timeZone: p.TIMEZONESTR ?? p.TIMEZONE ?? null,
    factory,
    today: { dawn: p.TODAYDAWN ?? null, sunrise: p.TODAYSUNRISE ?? null, sunset: p.TODAYSUNSET ?? null, dusk: p.TODAYDUSK ?? null },
    localTime: p.LOCALTIME ?? null,
  };
}

export const FACTORY_WARNING = (l: Location) =>
  `twilight times are calculated for latitude ${l.latitude}, longitude ${l.longitude} (time zone ${String(l.timeZone)}), the console's factory location, not the show's: today's sunset reads ${String(l.today.sunset)}. Set the location in Menu > Settings > Date and Time (Session Time: Timezone, Longitude, Latitude) before relying on dawn, sunrise, sunset or dusk`;

/** One entry in the tools' terms, from its properties (display text). */
export function describeEntry(no: number, props: Record<string, unknown>): Record<string, unknown> {
  const names = Object.keys(props);
  const get = (role: AgendaRole) => {
    const p = propFor(names, role);
    return p === undefined ? undefined : props[p];
  };
  const out: Record<string, unknown> = { no };
  const put = (key: string, v: unknown) => {
    if (v !== undefined && v !== null && v !== "") out[key] = v;
  };
  put("name", get("name"));
  put("mode", get("mode"));
  put("date", get("date"));
  put("time", get("time"));
  put("offset", get("offset"));
  put("validDuration", get("validDuration"));
  put("enabled", get("enabled"));
  put("object", get("object"));
  put("action", get("action"));
  put("command", get("command"));
  put("untilDate", get("untilDate"));
  put("untilTime", get("untilTime"));
  put("everyMinutes", get("everyMinutes"));
  put("everyYear", get("everyYear"));
  const planned: Record<string, unknown> = {};
  if (get("plannedDate") !== undefined) planned.date = get("plannedDate");
  if (get("plannedTime") !== undefined) planned.time = get("plannedTime");
  if (get("countdown") !== undefined) planned.countdown = get("countdown");
  if (Object.keys(planned).length) out.planned = planned;
  return out;
}

export interface ReadAgendaArgs {
  no?: number;
  limit?: number;
  detail?: boolean;
}

/** gma3_agenda: the entries, whether the agenda runs, and the location. */
export async function readAgendaTool(ctx: ToolContext, args: ReadAgendaArgs): Promise<Record<string, unknown>> {
  const { bridge } = ctx;
  const limit = Math.min(Math.max(1, args.limit ?? 50), 200);
  const col = await readAgendas(bridge);
  const notes: string[] = [];
  let location: Location | { error: string };
  try {
    location = await readLocation(bridge);
    if (location.factory) notes.push(FACTORY_WARNING(location));
  } catch (err) {
    location = { error: err instanceof Error ? err.message : String(err) };
  }
  if (col.running === false) notes.push("the agenda is not running (Agendas Running = No): no entry fires until it is switched on");
  if (!col.complete) notes.push(`the entry list could not be read completely${col.error ? ` (${col.error})` : ""}`);
  const wanted = args.no !== undefined ? col.slots.filter((s) => s.no === args.no) : col.slots.slice(0, limit);
  const entries: Array<Record<string, unknown>> = [];
  for (const s of wanted) {
    try {
      const res = await readObject(bridge, s.addr ?? `Agenda ${s.no}`, args.detail ? { schema: true } : {});
      const e = describeEntry(s.no, res.properties ?? {});
      if (res.class) e.class = res.class;
      if (args.detail) {
        e.properties = res.properties ?? {};
        e.schema = (res.schema ?? []).map((x) => x.name);
      }
      entries.push(e);
    } catch (err) {
      entries.push({ no: s.no, name: s.name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return {
    tool: "gma3_agenda",
    running: col.running,
    location,
    total: col.slots.length,
    count: entries.length,
    ...(args.no === undefined && col.slots.length > limit ? { truncated: true, note: `${col.slots.length - limit} more entries; raise limit or read one with no` } : {}),
    ...(args.no !== undefined && entries.length === 0 ? { error: `Agenda ${args.no} does not exist` } : {}),
    entries,
    ...(notes.length ? { notes } : {}),
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface StoreAgendaArgs {
  no?: unknown;
  name?: unknown;
  mode?: unknown;
  date?: unknown;
  time?: unknown;
  offset_minutes?: unknown;
  valid_duration?: unknown;
  enabled?: unknown;
  sequence?: unknown;
  macro?: unknown;
  plugin?: unknown;
  command?: unknown;
  action?: unknown;
  until_date?: unknown;
  until_time?: unknown;
  every_minutes?: unknown;
  every_year?: unknown;
  overwrite?: unknown;
  preview?: unknown;
}

type TargetKind = "sequence" | "macro" | "plugin";
const TARGET_KEYWORD: Record<TargetKind, string> = { sequence: "Sequence", macro: "Macro", plugin: "Plugin" };

export interface AgendaSpec {
  no: number;
  ref: string;
  name?: string;
  mode: AgendaMode;
  date: string;
  time?: number;
  offset?: number;
  validDuration?: number;
  enabled: boolean;
  target?: { kind: TargetKind; ref: string };
  command?: string;
  action?: string;
  untilDate?: string;
  untilTime?: number;
  everyMinutes?: number;
  everyYear?: boolean;
  overwrite: boolean;
}

/** Check a request before anything is read or sent. */
export function parseAgenda(a: StoreAgendaArgs): AgendaSpec {
  const no = a.no;
  if (typeof no !== "number" || !Number.isInteger(no) || no < 1 || no > MAX_NO) throw new ValidationError(`no must be a whole number 1 to ${MAX_NO} (got ${describe(no)})`, "no");
  const mode = (a.mode ?? "absolute") as AgendaMode;
  if (!AGENDA_MODES.includes(mode)) throw new ValidationError(`mode must be one of ${AGENDA_MODES.join(", ")} (got ${describe(a.mode)})`, "mode");
  const date = isoDate("date", a.date);
  const spec: AgendaSpec = { no, ref: `Agenda ${no}`, mode, date, enabled: a.enabled !== false, overwrite: a.overwrite === true };
  if (a.enabled !== undefined && typeof a.enabled !== "boolean") throw new ValidationError(`enabled must be true or false (got ${describe(a.enabled)})`, "enabled");
  if (a.name !== undefined) spec.name = objectName("name", a.name);
  if (mode === "absolute") {
    if (a.time === undefined) throw new ValidationError('time is required for mode "absolute" ("HH:MM" or "HH:MM:SS")', "time");
    spec.time = clockSeconds("time", a.time);
    if (a.offset_minutes !== undefined) throw new ValidationError('offset_minutes is for a twilight mode (dawn, sunrise, sunset, dusk); an "absolute" entry fires at its time', "offset_minutes");
  } else {
    if (a.time !== undefined) throw new ValidationError(`time is not used with mode "${mode}": the console calculates the time from the location; use offset_minutes to move it`, "time");
    if (a.offset_minutes !== undefined) {
      if (typeof a.offset_minutes !== "number" || !Number.isFinite(a.offset_minutes) || Math.abs(a.offset_minutes) > 720) {
        throw new ValidationError(`offset_minutes must be a number of minutes from -720 to 720 (got ${describe(a.offset_minutes)})`, "offset_minutes");
      }
      spec.offset = Math.round(a.offset_minutes * 60);
    }
  }
  if (a.valid_duration !== undefined) {
    if (typeof a.valid_duration !== "number" || !Number.isFinite(a.valid_duration) || a.valid_duration < 0 || a.valid_duration > 7 * 86400) {
      throw new ValidationError(`valid_duration must be seconds from 0 to ${7 * 86400} (got ${describe(a.valid_duration)})`, "valid_duration");
    }
    spec.validDuration = Math.round(a.valid_duration);
  }
  const targets = (["sequence", "macro", "plugin"] as const).filter((k) => a[k] !== undefined);
  const given = [...targets, ...(a.command !== undefined ? ["command"] : [])];
  if (given.length !== 1) throw new ValidationError(`give exactly one of sequence, macro, plugin or command (got ${given.length ? given.join(", ") : "none"})`, "sequence");
  if (targets.length) {
    const kind = targets[0];
    const v = a[kind];
    let ref: string;
    if (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= MAX_NO) ref = `${TARGET_KEYWORD[kind]} ${v}`;
    else if (typeof v === "string" && v.trim() !== "") ref = `${TARGET_KEYWORD[kind]} ${quoteName(objectName(kind, v) as string)}`;
    else throw new ValidationError(`${kind} must be a number or a name (got ${describe(v)})`, kind);
    spec.target = { kind, ref };
    if (a.action !== undefined) {
      if (typeof a.action !== "string" || a.action.trim() === "" || /[\x00-\x1f"]/.test(a.action)) throw new ValidationError(`action must be the console's action name, such as "Go+" or "Off" (got ${describe(a.action)})`, "action");
      spec.action = a.action.trim();
    }
  } else {
    const c = a.command;
    if (typeof c !== "string" || c.trim() === "") throw new ValidationError(`command must be a non-empty command line (got ${describe(c)})`, "command");
    if (/[\x00-\x1f\x7f]/.test(c)) throw new ValidationError("command must be one line without control characters", "command");
    if (c.length > 1000) throw new ValidationError("command is longer than 1000 characters", "command");
    spec.command = c.trim();
    if (a.action !== undefined) throw new ValidationError("action goes with sequence, macro or plugin; a command runs as written", "action");
  }
  if (a.until_date !== undefined) {
    spec.untilDate = isoDate("until_date", a.until_date);
    if (spec.untilDate < date) throw new ValidationError(`until_date ${spec.untilDate} is before date ${date}`, "until_date");
  }
  if (a.until_time !== undefined) spec.untilTime = clockSeconds("until_time", a.until_time);
  if (a.every_minutes !== undefined) {
    if (typeof a.every_minutes !== "number" || !Number.isInteger(a.every_minutes) || a.every_minutes < 1 || a.every_minutes > 1440) {
      throw new ValidationError(`every_minutes must be a whole number 1 to 1440 (got ${describe(a.every_minutes)})`, "every_minutes");
    }
    if (spec.untilDate === undefined && spec.untilTime === undefined) throw new ValidationError("every_minutes repeats until until_date or until_time; give one (the console repeats only up to an end)", "every_minutes");
    spec.everyMinutes = a.every_minutes;
  }
  if (a.every_year !== undefined) {
    if (typeof a.every_year !== "boolean") throw new ValidationError(`every_year must be true or false (got ${describe(a.every_year)})`, "every_year");
    spec.everyYear = a.every_year;
  }
  return spec;
}

/** The roles a request writes, in the order they are set (enabled is set first to No and last to the request). */
export function rolesFor(spec: AgendaSpec): AgendaRole[] {
  const r: AgendaRole[] = ["enabled", "mode", "date"];
  if (spec.name !== undefined) r.push("name");
  if (spec.time !== undefined) r.push("time");
  if (spec.offset !== undefined) r.push("offset");
  if (spec.validDuration !== undefined) r.push("validDuration");
  if (spec.target) r.push("object");
  if (spec.action !== undefined) r.push("action");
  if (spec.command !== undefined) r.push("command");
  if (spec.untilDate !== undefined) r.push("untilDate");
  if (spec.untilTime !== undefined) r.push("untilTime");
  if (spec.everyMinutes !== undefined) r.push("everyMinutes");
  if (spec.everyYear !== undefined) r.push("everyYear");
  return r;
}

/** Map every role a request writes to a writable property of the schema; the roles that have none. */
export function mapRoles(spec: AgendaSpec, schema: Array<{ name: string; readOnly?: boolean }>): { props: Partial<Record<AgendaRole, string>>; missing: string[] } {
  const writable = schema.filter((s) => s.readOnly !== true).map((s) => s.name);
  const props: Partial<Record<AgendaRole, string>> = {};
  const missing: string[] = [];
  for (const role of rolesFor(spec)) {
    const p = propFor(writable, role);
    if (p === undefined) missing.push(`${role} (${AGENDA_PROPS[role].join(" or ")})`);
    else props[role] = p;
  }
  return { props, missing };
}

/** The value sent for a role. */
function valueFor(role: AgendaRole, spec: AgendaSpec): string {
  switch (role) {
    case "name":
      return spec.name as string;
    case "mode":
      return MODE_TEXT[spec.mode];
    case "date":
      return consoleDate(spec.date);
    case "time":
      return consoleTime(spec.time as number);
    case "offset":
      return String(spec.offset);
    case "validDuration":
      return String(spec.validDuration);
    case "enabled":
      return spec.enabled ? "Yes" : "No";
    case "action":
      return spec.action as string;
    case "command":
      return spec.command as string;
    case "untilDate":
      return consoleDate(spec.untilDate as string);
    case "untilTime":
      return consoleTime(spec.untilTime as number);
    case "everyMinutes":
      return String(spec.everyMinutes);
    case "everyYear":
      return spec.everyYear ? "Yes" : "No";
    default:
      throw new Error(`no value for ${role}`);
  }
}

/** Compare one role's read-back with the request: "match", "differs" or "unknown" (a form this tool cannot read). */
export function compareRole(role: AgendaRole, spec: AgendaSpec, got: unknown): "match" | "differs" | "unknown" {
  if (got === undefined || got === null) return "differs";
  switch (role) {
    case "name":
    case "command":
      return String(got).trim() === (role === "name" ? spec.name : spec.command) ? "match" : "differs";
    case "mode":
    case "action": {
      const want = role === "mode" ? MODE_TEXT[spec.mode] : (spec.action as string);
      return String(got).trim().toLowerCase().replace(/\s+/g, " ") === want.toLowerCase() ? "match" : "differs";
    }
    case "date":
    case "untilDate": {
      const want = role === "date" ? spec.date : spec.untilDate;
      const d = parseConsoleDate(got);
      if (!d) return "unknown";
      if ("iso" in d) return d.iso === want ? "match" : "differs";
      return d.ambiguous.includes(want as string) ? "unknown" : "differs";
    }
    case "time":
    case "untilTime": {
      const s = parseConsoleClock(got);
      if (s === null) return "unknown";
      return s === (role === "time" ? spec.time : spec.untilTime) ? "match" : "differs";
    }
    case "offset":
    case "validDuration": {
      const s = parseSignedSeconds(got);
      if (s === null) return "unknown";
      return Math.abs(s - (role === "offset" ? (spec.offset as number) : (spec.validDuration as number))) < 0.5 ? "match" : "differs";
    }
    case "everyMinutes": {
      const n = Number(String(got).trim());
      return Number.isFinite(n) ? (n === spec.everyMinutes ? "match" : "differs") : "unknown";
    }
    case "enabled":
    case "everyYear": {
      const b = yesNo(got);
      if (b === null) return "unknown";
      return b === (role === "enabled" ? spec.enabled : spec.everyYear) ? "match" : "differs";
    }
    default:
      return "unknown";
  }
}

const ENTRY_CLASS = /agenda/i;

/** gma3_store_agenda, one entry. */
export async function storeAgenda(ctx: ToolContext, raw: StoreAgendaArgs): Promise<OperationResult> {
  const op = "store_agenda";
  let spec: AgendaSpec;
  try {
    spec = parseAgenda(raw);
  } catch (err) {
    if (err instanceof ValidationError) return validationFailure(op, { agenda: raw.no ?? null }, [err.message]);
    throw err;
  }
  const preview = raw.preview === true;
  const target = { agenda: spec.no };
  const { bridge } = ctx;

  const body = async (): Promise<OperationResult> => {
    const steps: StepResult[] = [];
    const warnings: string[] = [];
    const fail = (step: StepResult, extra: Record<string, unknown> = {}) => {
      steps.push(step);
      return buildResult({ operation: op, target, steps, warnings, extra });
    };

    // 1. The collection: is the number free, does the agenda run, which schema can be read before anything is sent.
    let col: Awaited<ReturnType<typeof readAgendas>>;
    try {
      col = await readAgendas(bridge);
    } catch (err) {
      return fail(asRead(stepFromError("read_agendas", err, { op: "object" })));
    }
    if (!col.complete) return fail({ name: "read_agendas", kind: "read", status: "failed", op: "object", error: `the agenda entries could not all be read${col.error ? ` (${col.error})` : ""}, so whether Agenda ${spec.no} is free is unknown; nothing was sent` });
    const taken = col.slots.find((s) => s.no === spec.no);
    steps.push({ name: "read_agendas", kind: "read", status: "succeeded", op: "object", detail: { entries: col.slots.length, running: col.running, ...(taken ? { taken: { no: taken.no, name: taken.name } } : {}) } });
    if (taken && !spec.overwrite) {
      return fail({ name: "check_slot", kind: "read", status: "failed", error: `Agenda ${spec.no} is taken${taken.name ? ` (${JSON.stringify(taken.name)})` : ""}; pass overwrite: true to replace it, or pick a free number (used: ${col.slots.map((s) => s.no).join(", ")})` });
    }
    if (col.running === false) warnings.push("the agenda is not running (Agendas Running = No): the entry is stored but does not fire until the agenda runs");

    // 2. The target exists.
    let targetAddr: string | undefined;
    if (spec.target) {
      try {
        const res = await readObjects(bridge, spec.target.ref, ["Name"], 1);
        const it = res?.items?.[0];
        if (!it || it.invalid) return fail({ name: "check_target", kind: "read", status: "failed", op: "objects", error: `${spec.target.ref} does not exist; nothing was sent` });
        if (it.class && !new RegExp(`^${TARGET_KEYWORD[spec.target.kind]}`, "i").test(String(it.class))) {
          return fail({ name: "check_target", kind: "read", status: "failed", op: "objects", error: `${spec.target.ref} reads class ${it.class}, not a ${spec.target.kind}; nothing was sent` });
        }
        targetAddr = it.addr;
        steps.push({ name: "check_target", kind: "read", status: "succeeded", op: "objects", detail: { ref: spec.target.ref, name: it.name, addr: it.addr } });
      } catch (err) {
        return fail(asRead(stepFromError("check_target", err, { op: "objects" })));
      }
    }

    // 3. Twilight: the location the console calculates with.
    if (spec.mode !== "absolute") {
      try {
        const loc = await readLocation(bridge);
        steps.push({ name: "read_location", kind: "read", status: "succeeded", op: "object", detail: loc });
        if (loc.factory) warnings.push(FACTORY_WARNING(loc));
      } catch (err) {
        warnings.push(`the console's location could not be read (${err instanceof Error ? err.message : String(err)}), so whether ${spec.mode} is calculated for the show's place is unknown`);
      }
    }

    // 4. The property names, from an entry that exists (the one replaced, or any other) before anything is sent.
    let props: Partial<Record<AgendaRole, string>> | undefined;
    const schemaFrom = taken ?? col.slots[0];
    if (schemaFrom) {
      try {
        const res = await readObject(bridge, schemaFrom.addr ?? `Agenda ${schemaFrom.no}`, { properties: false, schema: true });
        const mapped = mapRoles(spec, res.schema ?? []);
        if (mapped.missing.length) {
          return fail({ name: "map_properties", kind: "read", status: "failed", op: "object", error: `Agenda ${schemaFrom.no}'s properties have no writable ${mapped.missing.join(", ")}; this console's agenda entries cannot hold the request, nothing was sent`, detail: { schema: (res.schema ?? []).map((s) => s.name) } });
        }
        props = mapped.props;
        steps.push({ name: "map_properties", kind: "read", status: "succeeded", op: "object", detail: { from: `Agenda ${schemaFrom.no}`, properties: props } });
      } catch (err) {
        return fail(asRead(stepFromError("map_properties", err, { op: "object" })));
      }
    }

    const commands: string[] = [];
    if (taken) commands.push(`Delete ${spec.ref} /NoConfirmation`);
    commands.push(`Store ${spec.ref} /NoConfirmation`);
    if (spec.target) commands.push(`Assign ${spec.target.ref} At ${spec.ref}`);
    const sets = rolesFor(spec).filter((r) => r !== "object");
    if (preview) {
      return buildResult({
        operation: op,
        target,
        steps,
        warnings,
        summary: `Preview only; nothing was sent (${commands.length} command(s) and ${sets.length + 1} property write(s) planned).`,
        extra: {
          preview: true,
          plan: {
            commands: commands.map((c) => bridge.sentCommand?.(c) ?? c),
            properties: [
              { property: props?.enabled ?? "Enabled", value: "No", why: "disabled while it is configured" },
              ...sets.filter((r) => r !== "enabled").map((r) => ({ property: props?.[r] ?? AGENDA_PROPS[r][0], value: valueFor(r, spec) })),
              { property: props?.enabled ?? "Enabled", value: spec.enabled ? "Yes" : "No" },
            ],
            ...(props ? {} : { note: "no entry exists yet, so the property names are read from the new entry before it is configured" }),
          },
        },
      });
    }

    // 5. Replace: delete the old entry, read the slot free.
    if (taken) {
      const del = await commandStep(bridge, "delete_old", `Delete ${spec.ref} /NoConfirmation`);
      steps.push(del);
      if (del.status !== "succeeded") return buildResult({ operation: op, target, steps, warnings });
      try {
        const left = await readObjects(bridge, spec.ref, [], 1);
        const still = left?.items?.[0] && !left.items[0].invalid;
        if (still) return fail({ name: "check_deleted", kind: "read", status: "failed", op: "objects", error: `${spec.ref} still exists after Delete; nothing more was sent` });
        steps.push({ name: "check_deleted", kind: "read", status: "succeeded", op: "objects" });
      } catch (err) {
        return fail(asRead(stepFromError("check_deleted", err, { op: "objects" })));
      }
    }

    // 6. Store, then read it there.
    const store = await commandStep(bridge, "store", `Store ${spec.ref} /NoConfirmation`);
    steps.push(store);
    if (store.status === "unknown") {
      // The store's answer is unclear: read the slot before anything else.
      const there = await readObjects(bridge, spec.ref, [], 1).catch(() => undefined);
      if (!there?.items?.[0] || there.items[0].invalid) return buildResult({ operation: op, target, steps, warnings, summary: `store_agenda: Store ${spec.ref} got no clear answer and ${spec.ref} ${there === undefined ? "could not be read" : "does not exist"}; nothing more was sent` });
      steps[steps.length - 1] = { ...store, status: "succeeded", detail: { note: "the store's answer was unclear, but the entry reads there" } };
    } else if (store.status !== "succeeded") return buildResult({ operation: op, target, steps, warnings });
    let created: ObjectRead;
    try {
      created = await readObject(bridge, spec.ref, { properties: false, schema: true });
    } catch (err) {
      const step = asRead(stepFromError("check_stored", err, { op: "object" }));
      if (isNotFoundError(err)) step.error = `${spec.ref} does not exist after Store; nothing more was sent`;
      return fail(step);
    }
    if (created.class && !ENTRY_CLASS.test(created.class)) return fail({ name: "check_stored", kind: "read", status: "failed", op: "object", error: `${spec.ref} reads class ${created.class}, not an agenda entry; nothing more was sent` });
    steps.push({ name: "check_stored", kind: "read", status: "succeeded", op: "object", detail: { class: created.class, addr: created.addr } });

    /**
     * Delete the entry this call created and read the slot: "gone" only when the read shows it absent. An answered
     * Delete is not proof (review of #160): the console can answer OK and keep the entry.
     */
    const removeNew = async (name: string): Promise<"gone" | "still there" | "unknown"> => {
      const del = await commandStep(bridge, name, `Delete ${spec.ref} /NoConfirmation`);
      steps.push(del);
      if (del.status === "failed") return "still there";
      try {
        const left = await readObjects(bridge, spec.ref, [], 1);
        const there = Boolean(left?.items?.[0] && !left.items[0].invalid);
        steps.push({ name: "check_removed", kind: "read", status: there ? "failed" : "succeeded", op: "objects", ...(there ? { error: `${spec.ref} still exists after Delete` } : {}) });
        return there ? "still there" : "gone";
      } catch (err) {
        steps.push(asRead(stepFromError("check_removed", err, { op: "objects" })));
        return "unknown";
      }
    };
    const removedText = (r: "gone" | "still there" | "unknown") =>
      r === "gone" ? "deleted again (read back absent)" : r === "still there" ? "NOT deleted: it is still there" : "possibly not deleted: whether it is still there could not be read";

    // 7. The new entry's schema, when no entry could tell before.
    if (!props) {
      const mapped = mapRoles(spec, created.schema ?? []);
      if (mapped.missing.length) {
        steps.push({ name: "map_properties", kind: "read", status: "failed", op: "object", error: `the new entry's properties have no writable ${mapped.missing.join(", ")}`, detail: { schema: (created.schema ?? []).map((s) => s.name) } });
        const removed = await removeNew("delete_unusable");
        if (removed !== "gone") warnings.push(`the new ${spec.ref} is ${removedText(removed)}; it holds the console's current date and time and may fire: check it now`);
        return buildResult({
          operation: op,
          target,
          steps,
          warnings,
          summary: `store_agenda failed: this console's agenda entries have no writable ${mapped.missing.join(", ")}; the new ${spec.ref} was ${removedText(removed)}`,
        });
      }
      props = mapped.props;
      steps.push({ name: "map_properties", kind: "read", status: "succeeded", op: "object", detail: { from: spec.ref, properties: props } });
    }
    const p = props;

    // 8. Disable (confirmed), assign, write each property (each write checked against what it reads back).
    const disabledSpec: AgendaSpec = { ...spec, enabled: false };
    const setChecked = async (name: string, role: AgendaRole, value: string, want: AgendaSpec): Promise<StepResult> =>
      requestStep(bridge, name, "set", { ref: spec.ref, property: p[role], value }, (res) => {
        const r = (res ?? {}) as { value?: unknown; readOk?: unknown; readError?: unknown };
        const detail = { property: p[role], value, read: r.value ?? null };
        if (r.readOk === false || r.value === undefined || r.value === null) {
          return { name, status: "failed", op: "set", detail, error: `${p[role]} could not be read back after the write${r.readError ? ` (${String(r.readError)})` : ""}, so whether the console took ${JSON.stringify(value)} is unknown` };
        }
        const cmp = compareRole(role, want, r.value);
        if (cmp === "differs") return { name, status: "failed", op: "set", detail, error: `the console did not take ${p[role]} = ${JSON.stringify(value)}: it reads ${JSON.stringify(r.value)}` };
        if (cmp === "unknown") return { name, status: "failed", op: "set", detail, error: `${p[role]} reads ${JSON.stringify(r.value)} after the write, a form this tool cannot compare with ${JSON.stringify(value)}` };
        return { name, status: "succeeded", op: "set", detail };
      });
    const runPlan = async (plan: Array<{ name: string; run: () => Promise<StepResult> }>): Promise<StepResult | null> => {
      for (const item of plan) {
        let step: StepResult;
        try {
          step = await item.run();
        } catch (err) {
          step = stepFromError(item.name, err);
        }
        steps.push(step);
        if (step.status !== "succeeded") {
          for (const l of plan.slice(plan.indexOf(item) + 1)) steps.push({ name: l.name, status: "skipped", error: `not attempted: an earlier step was ${step.status}` });
          return step;
        }
      }
      return null;
    };
    const leftDisabled = `${spec.ref} was stored and left disabled: it is not fully configured`;

    const disable = await setChecked("disable_while_configuring", "enabled", "No", disabledSpec).catch((err) => stepFromError("disable_while_configuring", err));
    steps.push(disable);
    if (disable.status !== "succeeded") {
      // A new entry starts at the console's current date and time: one that may still be enabled must not stay.
      const removed = await removeNew("delete_unconfirmed");
      if (removed !== "gone") warnings.push(`${spec.ref} may still be enabled with the console's current date and time and is ${removedText(removed)}: check it now`);
      return buildResult({ operation: op, target, steps, warnings, summary: `store_agenda failed: ${spec.ref} could not be confirmed disabled (${disable.error ?? disable.status}); it was ${removedText(removed)}, and nothing was configured` });
    }
    const plan: Array<{ name: string; run: () => Promise<StepResult> }> = [];
    if (spec.target) plan.push({ name: "assign", run: () => commandStep(bridge, "assign", `Assign ${spec.target!.ref} At ${spec.ref}`) });
    for (const role of sets) if (role !== "enabled") plan.push({ name: `set_${role}`, run: () => setChecked(`set_${role}`, role, valueFor(role, spec), spec) });
    const failedWrite = await runPlan(plan);
    if (failedWrite) {
      warnings.push(leftDisabled);
      // A write the console answered with another value is a mismatch; one that got no answer or no read is not judged.
      const judged = failedWrite.op === "set" && /did not take/.test(failedWrite.error ?? "");
      return buildResult({ operation: op, target, steps, warnings, ...(judged ? { verification: { status: "mismatched", checked: "each write's read-back", detail: failedWrite.error } } : {}) });
    }

    // 9. While it is still disabled: read back every written property and the Object by address. Only a full match
    // enables it: an entry is never switched on unchecked.
    let verification: Verification;
    const extra: Record<string, unknown> = {};
    const checked = "every written property of the entry while it was disabled, and its Object by address";
    try {
      const back = await readObject(bridge, spec.ref);
      const pr = back.properties ?? {};
      const mismatches: string[] = [];
      const unknown: string[] = [];
      const actual: Record<string, unknown> = {};
      for (const role of rolesFor(spec)) {
        if (role === "object") continue;
        const want = role === "enabled" ? disabledSpec : spec;
        const got = pr[p[role] as string];
        actual[role] = got ?? null;
        if (got === undefined || got === null) {
          unknown.push(`${p[role]} could not be read`);
          continue;
        }
        const r = compareRole(role, want, got);
        if (r === "differs") mismatches.push(`${p[role]}: expected ${JSON.stringify(role === "enabled" ? "No" : valueFor(role, spec))}, reads ${JSON.stringify(got)}`);
        else if (r === "unknown") unknown.push(`${p[role]} reads ${JSON.stringify(got)}, a form this tool cannot compare with ${JSON.stringify(valueFor(role, want))}`);
      }
      if (spec.target) {
        const objField = p.object as string;
        const res = await readObjects(bridge, spec.ref, [objField], 1, { asText: false });
        const h = res?.items?.[0]?.fields?.[objField] as { addr?: string; name?: string; class?: string } | undefined;
        actual.object = h ?? null;
        if (!h || typeof h !== "object") mismatches.push(`${objField}: reads nothing, not ${spec.target.ref}`);
        else if (targetAddr === undefined || h.addr === undefined) unknown.push(`${objField} reads ${JSON.stringify(h.name ?? null)}, but ${targetAddr === undefined ? `${spec.target.ref}'s address` : "its address"} could not be read, so whether it is ${spec.target.ref} is unknown`);
        else if (h.addr !== targetAddr) mismatches.push(`${objField}: reads ${h.name ?? h.addr} (${h.addr}), not ${spec.target.ref} (${targetAddr})`);
      }
      const describeIt = describeEntry(spec.no, pr);
      if (describeIt.planned) extra.planned = describeIt.planned;
      if (mismatches.length) verification = { status: "mismatched", checked, actual, detail: mismatches.join("; ") };
      else if (unknown.length) verification = { status: "unavailable", checked, actual, detail: unknown.join("; ") };
      else verification = { status: "matched", checked, actual };
    } catch (err) {
      verification = { status: "unavailable", checked, detail: `the entry could not be read back: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (verification.status !== "matched") {
      steps.push({ name: "check_before_enable", kind: "read", status: "failed", op: "object", error: `${verification.detail ?? verification.status}; ${spec.ref} stays disabled` });
      if (spec.enabled) steps.push({ name: "set_enabled", status: "skipped", error: "not attempted: the configuration did not read back as requested" });
      warnings.push(leftDisabled);
      return buildResult({ operation: op, target, steps, warnings, verification, extra });
    }
    steps.push({ name: "check_before_enable", kind: "read", status: "succeeded", op: "object" });

    // 10. Enable last, when asked; the write is checked like the others.
    if (spec.enabled) {
      const en = await setChecked("set_enabled", "enabled", "Yes", spec).catch((err) => stepFromError("set_enabled", err));
      steps.push(en);
      if (en.status !== "succeeded") {
        warnings.push(`${spec.ref} is configured as requested but could not be confirmed enabled: ${en.error ?? en.status}`);
        return buildResult({ operation: op, target, steps, warnings, verification: { status: "mismatched", checked: `${checked}, then Enabled`, detail: en.error ?? "Enabled did not read Yes" }, extra });
      }
    }
    return buildResult({ operation: op, target, steps, warnings, verification: { ...verification, checked: spec.enabled ? `${checked}, then Enabled read Yes` : checked }, extra });
  };
  return preview ? body() : ctx.mutations.run(body);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const STORE_DESCRIPTION =
  "Create an Agenda entry (or with overwrite: true replace one): a time of day (mode absolute, date + time) or a twilight time (dawn, sunrise, sunset, dusk, date + offset_minutes) that runs a sequence, macro or plugin (with an action such as Go+ or Off) or a command. " +
  "Repeat: until_date / until_time, every_minutes, every_year. Checks first: the number is free (or overwrite), the target exists, the entry's property names (read from an existing entry's schema, else from the new one). " +
  "Sends Store Agenda n and confirms it disabled (otherwise deletes it again), Assign <target> At Agenda n, sets each property and checks what each write reads; then reads the whole entry back while it is still disabled (the Object by address) and enables it only when everything matched, so a misconfigured entry never fires; reports the planned date and time. " +
  "Twilight times use the console's location (Date and Time settings): the result warns while it is the factory one. Day-of-week patterns are not set by this tool. preview: true plans without sending. " +
  BATCH_NOTE;

const itemShape = {
  no: z.number().int(),
  name: z.string().optional(),
  mode: z.enum(AGENDA_MODES).optional(),
  date: z.string().optional(),
  time: z.string().optional(),
  offset_minutes: z.number().optional(),
  valid_duration: z.number().optional(),
  enabled: z.boolean().optional(),
  sequence: z.union([z.number().int(), z.string()]).optional(),
  macro: z.union([z.number().int(), z.string()]).optional(),
  plugin: z.union([z.number().int(), z.string()]).optional(),
  command: z.string().optional(),
  action: z.string().optional(),
  until_date: z.string().optional(),
  until_time: z.string().optional(),
  every_minutes: z.number().int().optional(),
  every_year: z.boolean().optional(),
  overwrite: z.boolean().optional(),
};

const TARGET_FIELDS = ["sequence", "macro", "plugin", "command"] as const;

/**
 * The batch form's defaults, item by item, where fields belong together: an item that names its own target (sequence,
 * macro, plugin or command) replaces the call's target instead of adding a second one, and a command drops the call's
 * action; an item with a twilight mode drops the call's time, an absolute one the call's offset. The item's fields are
 * set explicitly to undefined so the merge (call defaults, then the item) leaves them out.
 */
export function withOwnTargets(args: Record<string, unknown>): Record<string, unknown> {
  const list = args.entries;
  if (!Array.isArray(list)) return args;
  const entries = list.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
    const it = { ...(raw as Record<string, unknown>) };
    const own = TARGET_FIELDS.filter((k) => it[k] !== undefined);
    if (own.length) {
      for (const k of TARGET_FIELDS) if (!own.includes(k)) it[k] = undefined;
      if (own.includes("command") && it.action === undefined) it.action = undefined;
    }
    if (it.mode !== undefined && it.mode !== "absolute" && !("time" in it)) it.time = undefined;
    if (it.mode === "absolute" && !("offset_minutes" in it)) it.offset_minutes = undefined;
    return it;
  });
  return { ...args, entries };
}

export const registerAgendaTools: RegisterTools = (server, ctx) => {
  server.registerTool(
    "gma3_agenda",
    {
      title: "Read the Agenda",
      description:
        "Read-only. The Agenda's entries (number, name, mode, start date and time, twilight offset, valid duration, enabled, object and action or command, repeat, planned next firing), whether the agenda runs, and the location twilight times are calculated for (with today's dawn, sunrise, sunset and dusk; a warning while it is the console's factory location). no: one entry. detail: true adds every property and the property names.",
      inputSchema: {
        no: z.number().int().optional().describe("One entry by number."),
        limit: z.number().int().optional().describe("Entries to read (default 50, at most 200)."),
        detail: z.boolean().optional().describe("Every property of each entry and its property names."),
      },
    },
    async (args) => {
      try {
        return json(await readAgendaTool(ctx, args as ReadAgendaArgs));
      } catch (err) {
        return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    "gma3_store_agenda",
    {
      title: "Create Agenda entries",
      description: STORE_DESCRIPTION,
      inputSchema: {
        no: z.number().int().optional().describe("The entry number. Required unless entries is given."),
        name: z.string().optional().describe("The entry's name."),
        mode: z.enum(AGENDA_MODES).optional().describe('"absolute" (default: date + time) or a twilight time: "dawn", "sunrise", "sunset", "dusk" (date + offset_minutes).'),
        date: z.string().optional().describe('Start date "YYYY-MM-DD" (required).'),
        time: z.string().optional().describe('Absolute mode: "HH:MM" or "HH:MM:SS" (required there; refused with a twilight mode).'),
        offset_minutes: z.number().optional().describe("Twilight mode: minutes from that time, negative before (e.g. -15)."),
        valid_duration: z.number().optional().describe("Seconds a missed entry may still fire (the console was off or the agenda stopped)."),
        enabled: z.boolean().optional().describe("Default true."),
        sequence: z.union([z.number().int(), z.string()]).optional().describe("Run this sequence (number or name). One of sequence, macro, plugin, command."),
        macro: z.union([z.number().int(), z.string()]).optional().describe("Run this macro."),
        plugin: z.union([z.number().int(), z.string()]).optional().describe("Run this plugin."),
        command: z.string().optional().describe('Or run this command line, e.g. "Go+ Executor 201".'),
        action: z.string().optional().describe('With sequence, macro or plugin: the console\'s action name, e.g. "Go+", "Off", "Toggle" (default: the console\'s).'),
        until_date: z.string().optional().describe('Repeat: end date "YYYY-MM-DD".'),
        until_time: z.string().optional().describe('Repeat: end time "HH:MM[:SS]".'),
        every_minutes: z.number().int().optional().describe("Repeat every n minutes until until_date / until_time."),
        every_year: z.boolean().optional().describe("Repeat every year."),
        overwrite: z.boolean().optional().describe("Replace an existing entry at this number (deleted first). Default false: a taken number is refused."),
        preview: z.boolean().optional().describe("Read and plan only; nothing is sent."),
        entries: z.array(z.object(itemShape)).optional().describe("Batch form: several entries, each with its own no."),
        ...batchOptionShape,
      },
    },
    async (args) =>
      operation(() =>
        (args as Record<string, unknown>).entries !== undefined
          ? runBatchCall(withOwnTargets(args as Record<string, unknown>), {
              ctx,
              operation: "store_agenda",
              listKey: "entries",
              identityKeys: ["no"],
              label: (it) => `Agenda ${String(it.no)}`,
              key: (it) => `agenda ${String(it.no)}`,
              check: (items) => duplicates(items.map((it) => String(it.no))).map((n) => `Agenda ${n} is in more than one item`),
              run: (it, c) => storeAgenda(c, it as StoreAgendaArgs),
            })
          : storeAgenda(ctx, args as StoreAgendaArgs),
      ),
  );
};
