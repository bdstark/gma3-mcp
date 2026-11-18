import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startHarness, type Harness } from "./helpers/tool-harness.ts";
import { SILENT } from "./helpers/fake-bridge.ts";
import {
  clockSeconds,
  consoleDate,
  isoDate,
  parseAgenda,
  parseConsoleDate,
  parseSignedSeconds,
  propFor,
  registerAgendaTools,
  rolesFor,
} from "../src/tools/agenda.ts";

/** The property schema an agenda entry has in this fake (the onPC binary's names, upper case as the bridge reads them). */
const SCHEMA = [
  "NAME", "MODE", "STARTDATE", "STARTTIME", "DAYLIGHTOFFSET", "VALIDDURATION", "ENABLED", "OBJECT", "ACTION", "COMMAND",
  "ENDDATE", "ENDTIME", "MINUTEINTERVAL", "REPEATEVERYYEAR",
];
const READ_ONLY = ["PLANNEDDATE", "PLANNEDTIME", "COUNTDOWN"];

interface Entry {
  props: Record<string, string>;
  object?: string;
}

/**
 * A console with an Agendas collection, a few targets and the station's TimeConfig. Store creates an entry with the
 * console's date and time, Set stores durations in the console's form ("-15m00.00"), Assign sets the Object.
 */
class Console {
  entries = new Map<number, Entry>();
  running = true;
  location = { LATITUDE: "49.7877998", LONGITUDE: "9.9361095", TIMEZONESTR: "(UTC-6:00)", TODAYSUNSET: "09:34:48", TODAYDUSK: "10:49:22", TODAYDAWN: "23:21:59", TODAYSUNRISE: "00:35:08" };
  schema = [...SCHEMA];
  targets = new Map<string, { class: string; name: string }>([
    ["Sequence 5", { class: "Sequence", name: "Festoon Bars" }],
    ["Macro 3", { class: "Macro", name: "Lights out" }],
  ]);
  /** Properties whose Set the console silently ignores. */
  ignore = new Set<string>();
  /** Commands the console ignores (answers OK, does nothing). */
  ignoreCmd?: RegExp;
  silent?: RegExp;
  setLog: Array<[string, string]> = [];

  add(no: number, props: Record<string, string> = {}, object?: string) {
    this.entries.set(no, { props: { ...this.defaults(), ...props }, object });
  }

  defaults(): Record<string, string> {
    return {
      NAME: "", MODE: "Absolute", STARTDATE: "17.11.2026", STARTTIME: "18:42:42", DAYLIGHTOFFSET: "0", VALIDDURATION: "0", ENABLED: "Yes",
      OBJECT: "", ACTION: "Go+", COMMAND: "", ENDDATE: "17.11.2026", ENDTIME: "18:42:42", MINUTEINTERVAL: "0", REPEATEVERYYEAR: "No",
      PLANNEDDATE: "17.11.2026", PLANNEDTIME: "18:42:42", COUNTDOWN: "0s",
    };
  }

  entryNo(ref: string): number | undefined {
    const m = ref.match(/^Agenda (\d+)$/) ?? ref.match(/^agenda:(\d+)$/);
    return m ? Number(m[1]) : undefined;
  }

  props(e: Entry): Record<string, string> {
    const out: Record<string, string> = {};
    for (const k of [...this.schema, ...READ_ONLY]) if (k in e.props) out[k] = e.props[k];
    out.OBJECT = e.object ? this.targets.get(e.object)!.name : "";
    return out;
  }

  object(a: Record<string, unknown>) {
    const ref = String(a.ref);
    if (ref === "ShowData.Agendas") {
      const items = [...this.entries.keys()].sort((x, y) => x - y).map((no) => ({ addr: `agenda:${no}`, name: this.entries.get(no)!.props.NAME || `Agenda ${no}`, fields: { No: no, Name: this.entries.get(no)!.props.NAME } }));
      return { class: "Agendas", properties: { RUNNING: this.running ? "Yes" : "No" }, children: { items, total: items.length } };
    }
    if (ref === "Root.StationSettings.TimeConfig") return { class: "TimeConfig", properties: { ...this.location } };
    const no = this.entryNo(ref);
    const e = no === undefined ? undefined : this.entries.get(no);
    if (!e) throw new Error(`no object found for '${ref}'`);
    return {
      class: "AgendaEvent",
      addr: `agenda:${no}`,
      ...(a.properties === false ? {} : { properties: this.props(e) }),
      ...(a.schema ? { schema: [...this.schema.map((name) => ({ name, readOnly: false })), ...READ_ONLY.map((name) => ({ name, readOnly: true }))] } : {}),
    };
  }

  objects(a: Record<string, unknown>) {
    const ref = String(a.ref);
    const t = this.targets.get(ref);
    if (t) return { total: 1, offset: 0, count: 1, items: [{ class: t.class, name: t.name, addr: `addr:${ref}`, fields: { Name: t.name } }] };
    const no = this.entryNo(ref);
    const e = no === undefined ? undefined : this.entries.get(no);
    if (!e) throw new Error("no objects found");
    const fields: Record<string, unknown> = {};
    for (const f of (a.fields as string[]) ?? []) {
      if (f === "OBJECT") fields.OBJECT = a.asText === false ? (e.object ? { class: this.targets.get(e.object)!.class, name: this.targets.get(e.object)!.name, addr: `addr:${e.object}` } : undefined) : this.props(e).OBJECT;
      else fields[f] = e.props[f];
    }
    return { total: 1, offset: 0, count: 1, items: [{ class: "AgendaEvent", name: e.props.NAME, addr: `agenda:${no}`, fields }] };
  }

  set(a: Record<string, unknown>) {
    const no = this.entryNo(String(a.ref));
    const e = no === undefined ? undefined : this.entries.get(no);
    if (!e) throw new Error(`no object found for '${String(a.ref)}'`);
    const prop = String(a.property);
    const value = String(a.value);
    this.setLog.push([prop, value]);
    if (!this.schema.includes(prop)) throw new Error(`Set failed: unknown property ${prop}`);
    if (!this.ignore.has(prop)) {
      if (prop === "DAYLIGHTOFFSET" || prop === "VALIDDURATION") {
        const s = Number(value);
        const sign = s < 0 ? "-" : "";
        const abs = Math.abs(s);
        e.props[prop] = abs >= 3600 ? `${sign}${Math.floor(abs / 3600)}h${String(Math.floor((abs % 3600) / 60)).padStart(2, "0")}m${String(abs % 60).padStart(2, "0")}.00` : `${sign}${Math.floor(abs / 60)}m${String(abs % 60).padStart(2, "0")}.00`;
      } else e.props[prop] = value;
    }
    return { ref: a.ref, property: prop, value: e.props[prop], readOk: true };
  }

  command(cmd: string): string | typeof SILENT {
    if (this.silent?.test(cmd)) return SILENT;
    if (this.ignoreCmd?.test(cmd)) return "OK";
    let m: RegExpMatchArray | null;
    if ((m = cmd.match(/^Store Agenda (\d+) \/NoConfirmation$/))) {
      if (this.entries.has(Number(m[1]))) throw new Error("the fake would ask: the tool must delete a taken entry first");
      this.add(Number(m[1]));
      return "OK";
    }
    if ((m = cmd.match(/^Delete Agenda (\d+) \/NoConfirmation$/))) {
      this.entries.delete(Number(m[1]));
      return "OK";
    }
    if ((m = cmd.match(/^Assign (\w+ \d+) At Agenda (\d+)$/))) {
      const e = this.entries.get(Number(m[2]));
      if (!e || !this.targets.has(m[1])) return "Error: no object";
      e.object = m[1];
      return "OK";
    }
    return "Syntax Error";
  }
}

let h: Harness;
let c: Console;

function install() {
  h.fake.reset();
  c = new Console();
  h.fake.on("object", (a) => c.object(a));
  h.fake.on("objects", (a) => c.objects(a));
  h.fake.on("set", (a) => c.set(a));
  h.fake.on("cmd", (a) => {
    const fb = c.command(String(a.command));
    return fb === SILENT ? SILENT : { command: a.command, feedback: fb };
  });
}

before(async () => {
  h = await startHarness(registerAgendaTools);
});
after(async () => {
  await h.close();
});
beforeEach(() => install());

const sets = () => h.fake.requests.filter((r) => r.op === "set").map((r) => `${String(r.args.property)}=${String(r.args.value)}`);

test("parsing: dates, times, modes, targets and repeats are checked before anything is read", () => {
  assert.equal(isoDate("date", "2026-12-24"), "2026-12-24");
  assert.throws(() => isoDate("date", "2026-02-30"), /not a calendar date/);
  assert.throws(() => isoDate("date", "24.12.2026"), /YYYY-MM-DD/);
  assert.equal(clockSeconds("time", "19:30"), 70200);
  assert.throws(() => clockSeconds("time", "24:00"), /HH:MM/);
  assert.equal(consoleDate("2026-12-24"), "24.12.2026");
  assert.deepEqual(parseConsoleDate("24.12.2026"), { iso: "2026-12-24" });
  assert.deepEqual(parseConsoleDate("2026-12-24"), { iso: "2026-12-24" });
  assert.deepEqual(parseConsoleDate("12/24/2026"), { iso: "2026-12-24" });
  assert.deepEqual(parseConsoleDate("05/06/2026"), { ambiguous: ["2026-05-06", "2026-06-05"] });
  assert.equal(parseSignedSeconds("-15m00.00"), -900);
  assert.equal(parseSignedSeconds("1h00m00.00"), 3600);
  assert.equal(parseSignedSeconds("-00:15:00"), -900);
  assert.equal(propFor(["Name", "StartDate"], "date"), "StartDate");
  assert.equal(propFor(["MODE"], "mode"), "MODE");

  const base = { no: 1, date: "2026-12-24", sequence: 5 };
  assert.throws(() => parseAgenda({ ...base }), /time is required for mode "absolute"/);
  assert.throws(() => parseAgenda({ ...base, mode: "sunset", time: "19:00" }), /not used with mode "sunset"/);
  assert.throws(() => parseAgenda({ ...base, time: "19:00", offset_minutes: 5 }), /for a twilight mode/);
  assert.throws(() => parseAgenda({ ...base, time: "19:00", macro: 3 }), /exactly one of sequence, macro, plugin or command/);
  assert.throws(() => parseAgenda({ no: 1, date: "2026-12-24", time: "19:00" }), /exactly one/);
  assert.throws(() => parseAgenda({ no: 1, date: "2026-12-24", time: "19:00", command: "Go+ Executor 201", action: "Off" }), /action goes with sequence/);
  assert.throws(() => parseAgenda({ ...base, time: "19:00", until_date: "2026-12-01" }), /before date/);
  assert.throws(() => parseAgenda({ ...base, time: "19:00", every_minutes: 10 }), /until_date or until_time/);
  assert.throws(() => parseAgenda({ ...base, mode: "dusk", offset_minutes: 900 }), /-720 to 720/);
  const s = parseAgenda({ ...base, mode: "sunset", offset_minutes: -15, until_date: "2027-01-06", name: "Festoons on" });
  assert.equal(s.offset, -900);
  assert.deepEqual(rolesFor(s), ["enabled", "mode", "date", "name", "offset", "object", "untilDate"]);
});

test("an absolute entry on an empty agenda: Store, disabled while configured, Assign, every property set, enabled last, all read back", async () => {
  const r = await h.callJson("gma3_store_agenda", { no: 1, name: "Doors", date: "2026-12-24", time: "19:30", sequence: 5, action: "Go+" });
  assert.equal(r.result.outcome, "succeeded", r.text);
  assert.equal(r.result.verification.status, "matched", r.text);
  assert.deepEqual(h.fake.commands, ["Store Agenda 1 /NoConfirmation", "Assign Sequence 5 At Agenda 1"]);
  const s = sets();
  assert.equal(s[0], "ENABLED=No", "disabled first");
  assert.equal(s[s.length - 1], "ENABLED=Yes", "enabled last");
  assert.ok(s.includes("MODE=Absolute") && s.includes("STARTDATE=24.12.2026") && s.includes("STARTTIME=19:30:00") && s.includes("NAME=Doors") && s.includes("ACTION=Go+"), s.join(", "));
  assert.equal(c.entries.get(1)?.object, "Sequence 5");
  assert.deepEqual(r.result.planned, { date: "17.11.2026", time: "18:42:42", countdown: "0s" });
  // The schema came from the new entry: no other entry existed.
  const mapStep = r.result.steps.find((x: { name: string }) => x.name === "map_properties");
  assert.equal(mapStep.detail.from, "Agenda 1");
});

test("a taken number is refused without overwrite; overwrite reads the schema from it first, deletes it, then stores", async () => {
  c.add(2, { NAME: "Old" }, "Macro 3");
  let r = await h.callJson("gma3_store_agenda", { no: 2, date: "2026-12-24", time: "20:00", sequence: 5 });
  assert.equal(r.result.outcome, "failed");
  assert.match(r.text, /Agenda 2 is taken \(\\"Old\\"\); pass overwrite: true/);
  assert.deepEqual(h.fake.commands, []);
  h.fake.requests.length = 0;
  r = await h.callJson("gma3_store_agenda", { no: 2, date: "2026-12-24", time: "20:00", sequence: 5, overwrite: true });
  assert.equal(r.result.outcome, "succeeded", r.text);
  assert.equal(r.result.verification.status, "matched", r.text);
  assert.deepEqual(h.fake.commands, ["Delete Agenda 2 /NoConfirmation", "Store Agenda 2 /NoConfirmation", "Assign Sequence 5 At Agenda 2"]);
  const mapStep = r.result.steps.find((x: { name: string }) => x.name === "map_properties");
  assert.equal(mapStep.detail.from, "Agenda 2");
  assert.equal(c.entries.get(2)?.props.NAME, "", "the replaced entry's name is gone");
});

test("a twilight entry: the offset reads back in the console's form; the factory location and a stopped agenda are warned about", async () => {
  c.running = false;
  const r = await h.callJson("gma3_store_agenda", { no: 3, mode: "sunset", offset_minutes: -15, date: "2026-11-18", until_date: "2027-01-06", macro: 3 });
  assert.equal(r.result.outcome, "succeeded", r.text);
  assert.equal(r.result.verification.status, "matched", r.text);
  assert.equal(c.entries.get(3)?.props.DAYLIGHTOFFSET, "-15m00.00");
  assert.equal(c.entries.get(3)?.props.MODE, "Sunset");
  assert.ok(!sets().some((x) => x.startsWith("STARTTIME")), "no start time for a twilight entry");
  const w = JSON.stringify(r.result.warnings);
  assert.match(w, /factory location/);
  assert.match(w, /not running/);
  c.location.LATITUDE = "47.6";
  c.location.LONGITUDE = "-122.3";
  const r2 = await h.callJson("gma3_store_agenda", { no: 4, mode: "dusk", date: "2026-11-18", macro: 3 });
  assert.doesNotMatch(JSON.stringify(r2.result.warnings ?? []), /factory location/);
});

test("a missing target or a schema without a needed property is refused before anything is sent", async () => {
  let r = await h.callJson("gma3_store_agenda", { no: 1, date: "2026-12-24", time: "19:30", sequence: 99 });
  assert.equal(r.result.outcome, "failed");
  assert.match(r.text, /Sequence 99 does not exist; nothing was sent/);
  assert.deepEqual(h.fake.commands, []);
  // Another entry tells the schema: no MINUTEINTERVAL, so every_minutes cannot be held.
  c.schema = SCHEMA.filter((x) => x !== "MINUTEINTERVAL");
  c.add(7);
  h.fake.requests.length = 0;
  r = await h.callJson("gma3_store_agenda", { no: 1, date: "2026-12-24", time: "19:30", sequence: 5, until_time: "23:00", every_minutes: 30 });
  assert.equal(r.result.outcome, "failed");
  assert.match(r.text, /no writable everyMinutes \(MINUTEINTERVAL\)/);
  assert.deepEqual(h.fake.commands, []);
});

test("on an empty agenda a schema without a needed property is found on the new entry, which is deleted again", async () => {
  c.schema = SCHEMA.filter((x) => x !== "REPEATEVERYYEAR");
  const r = await h.callJson("gma3_store_agenda", { no: 1, date: "2026-12-24", time: "19:30", sequence: 5, every_year: true });
  assert.equal(r.result.outcome, "partial");
  assert.match(r.result.summary, /no writable everyYear .* deleted again \(read back absent\)/);
  assert.deepEqual(h.fake.commands, ["Store Agenda 1 /NoConfirmation", "Delete Agenda 1 /NoConfirmation"]);
  assert.equal(c.entries.has(1), false);
});

test("an ignored write stops the entry disabled: it is never enabled with the console's default time (review of #160)", async () => {
  c.ignore.add("STARTTIME");
  const r = await h.callJson("gma3_store_agenda", { no: 1, date: "2026-12-24", time: "20:00", sequence: 5 });
  assert.equal(r.result.outcome, "partial", r.text);
  assert.equal(r.result.verification.status, "mismatched", r.text);
  const bad = r.result.steps.find((x: { name: string }) => x.name === "set_time");
  assert.equal(bad.status, "failed");
  assert.match(bad.error, /did not take STARTTIME = "20:00:00": it reads "18:42:42"/);
  assert.equal(c.entries.get(1)?.props.ENABLED, "No", "left disabled");
  assert.equal(c.entries.get(1)?.props.STARTTIME, "18:42:42");
  assert.ok(!sets().includes("ENABLED=Yes"), "never enabled");
  assert.match(JSON.stringify(r.result.warnings), /left disabled/);
});

test("an ignored Assign is caught by address while the entry is disabled, and it is not enabled", async () => {
  c.ignoreCmd = /^Assign/;
  const r = await h.callJson("gma3_store_agenda", { no: 1, date: "2026-12-24", time: "19:30", sequence: 5 });
  assert.equal(r.result.verification.status, "mismatched", r.text);
  assert.match(r.result.verification.detail, /OBJECT: reads nothing, not Sequence 5/);
  const check = r.result.steps.find((x: { name: string }) => x.name === "check_before_enable");
  assert.equal(check.status, "failed");
  assert.equal(c.entries.get(1)?.props.ENABLED, "No");
  assert.ok(!sets().includes("ENABLED=Yes"));
});

test("an ignored disable deletes the new entry again: nothing is assigned or configured on an entry that may be live", async () => {
  c.ignore.add("ENABLED");
  const r = await h.callJson("gma3_store_agenda", { no: 1, date: "2026-12-24", time: "19:30", sequence: 5 });
  assert.notEqual(r.result.outcome, "succeeded");
  assert.match(r.result.summary, /could not be confirmed disabled .* deleted again \(read back absent\)/);
  assert.deepEqual(h.fake.commands, ["Store Agenda 1 /NoConfirmation", "Delete Agenda 1 /NoConfirmation"]);
  assert.deepEqual(sets(), ["ENABLED=No"]);
  assert.equal(c.entries.has(1), false);
});

test("cleanup is read back: an ignored or unreadable Delete is reported as a live hazard, never as deleted (review of #160)", async () => {
  c.ignore.add("ENABLED");
  c.ignoreCmd = /^Delete/;
  let r = await h.callJson("gma3_store_agenda", { no: 1, date: "2026-12-24", time: "19:30", sequence: 5 });
  assert.match(r.result.summary, /NOT deleted: it is still there/);
  assert.match(JSON.stringify(r.result.warnings), /may still be enabled .* check it now/);
  assert.equal(c.entries.get(1)?.props.ENABLED, "Yes");
  install();
  c.ignore.add("ENABLED");
  let deleted = false;
  h.fake.on("objects", (a) => {
    if (deleted && String(a.ref) === "Agenda 1") throw new Error("read timed out on the console");
    return c.objects(a);
  });
  h.fake.on("cmd", (a) => {
    if (/^Delete/.test(String(a.command))) deleted = true;
    const fb = c.command(String(a.command));
    return fb === SILENT ? SILENT : { command: a.command, feedback: fb };
  });
  r = await h.callJson("gma3_store_agenda", { no: 1, date: "2026-12-24", time: "19:30", sequence: 5 });
  assert.match(r.result.summary, /possibly not deleted: whether it is still there could not be read/);
  assert.match(JSON.stringify(r.result.warnings), /check it now/);
  install();
  c.schema = SCHEMA.filter((x) => x !== "REPEATEVERYYEAR");
  c.ignoreCmd = /^Delete/;
  r = await h.callJson("gma3_store_agenda", { no: 1, date: "2026-12-24", time: "19:30", sequence: 5, every_year: true });
  assert.match(r.result.summary, /NOT deleted: it is still there/);
  assert.match(JSON.stringify(r.result.warnings), /may fire: check it now/);
});

test("an unreadable write or an unreadable entry before enabling leaves it disabled", async () => {
  h.fake.on("set", (a) => {
    const res = c.set(a);
    return a.property === "STARTDATE" ? { ...res, value: undefined, readOk: false, readError: "read failed" } : res;
  });
  let r = await h.callJson("gma3_store_agenda", { no: 1, date: "2026-12-24", time: "19:30", sequence: 5 });
  assert.equal(r.result.outcome, "partial", r.text);
  assert.match(r.text, /STARTDATE could not be read back after the write \(read failed\)/);
  assert.equal(c.entries.get(1)?.props.ENABLED, "No");
  install();
  // Every write reads back, but the whole entry cannot be read before enabling.
  h.fake.on("object", (a) => {
    if (String(a.ref) === "Agenda 1" && a.properties !== false && !a.schema) throw new Error("read timed out on the console");
    return c.object(a);
  });
  r = await h.callJson("gma3_store_agenda", { no: 1, date: "2026-12-24", time: "19:30", sequence: 5 });
  assert.equal(r.result.verification.status, "unavailable", r.text);
  assert.equal(c.entries.get(1)?.props.ENABLED, "No");
  assert.ok(!sets().includes("ENABLED=Yes"));
});

test("a value read back in a form the tool cannot compare is not enabled either", async () => {
  h.fake.on("set", (a) => {
    const res = c.set(a);
    if (a.property === "STARTDATE") {
      c.entries.get(1)!.props.STARTDATE = "Thursday";
      return { ...res, value: "Thursday" };
    }
    return res;
  });
  const r = await h.callJson("gma3_store_agenda", { no: 1, date: "2026-12-24", time: "19:30", sequence: 5 });
  assert.equal(r.result.outcome, "partial", r.text);
  assert.match(r.text, /a form this tool cannot compare/);
  assert.equal(c.entries.get(1)?.props.ENABLED, "No");
});

test("enabled: false stores the entry configured and disabled, without an enabling write", async () => {
  const r = await h.callJson("gma3_store_agenda", { no: 1, date: "2026-12-24", time: "19:30", sequence: 5, enabled: false });
  assert.equal(r.result.outcome, "succeeded", r.text);
  assert.equal(r.result.verification.status, "matched", r.text);
  assert.equal(c.entries.get(1)?.props.ENABLED, "No");
  assert.equal(sets().filter((x) => x.startsWith("ENABLED")).length, 1);
});

test("an enable the console ignores is a mismatch", async () => {
  h.fake.on("set", (a) => {
    if (a.property === "ENABLED" && a.value === "Yes") return { ref: a.ref, property: "ENABLED", value: "No", readOk: true };
    return c.set(a);
  });
  const r = await h.callJson("gma3_store_agenda", { no: 1, date: "2026-12-24", time: "19:30", sequence: 5 });
  assert.equal(r.result.verification.status, "mismatched", r.text);
  assert.match(JSON.stringify(r.result.warnings), /could not be confirmed enabled/);
});

test("a write that fails stops the entry, leaves it disabled and skips the rest", async () => {
  c.schema = [...SCHEMA];
  h.fake.on("set", (a) => {
    if (a.property === "STARTTIME") throw new Error("Set failed: illegal value");
    return c.set(a);
  });
  const r = await h.callJson("gma3_store_agenda", { no: 1, date: "2026-12-24", time: "19:30", command: "Go+ Executor 201" });
  assert.equal(r.result.outcome, "partial", r.text);
  assert.match(JSON.stringify(r.result.warnings), /left disabled/);
  assert.equal(c.entries.get(1)?.props.ENABLED, "No");
  const skipped = r.result.steps.filter((x: { status: string }) => x.status === "skipped").map((x: { name: string }) => x.name);
  assert.ok(skipped.includes("set_command"), skipped.join(", "));
  assert.ok(!sets().includes("ENABLED=Yes"));
});

test("an unclear Store is resolved by reading the slot; a missing entry stops", async () => {
  c.silent = /^Store/;
  const r = await h.callJson("gma3_store_agenda", { no: 1, date: "2026-12-24", time: "19:30", sequence: 5 });
  assert.notEqual(r.result.outcome, "succeeded");
  assert.match(r.result.summary, /no clear answer and Agenda 1 does not exist/);
  assert.equal(h.fake.requests.filter((x) => x.op === "set").length, 0);
});

test("preview: reads and plans, sends nothing", async () => {
  c.add(5);
  const r = await h.callJson("gma3_store_agenda", { no: 6, mode: "dusk", date: "2026-11-18", sequence: 5, preview: true });
  assert.equal(r.result.preview, true);
  assert.deepEqual(h.fake.commands, []);
  assert.equal(sets().length, 0);
  assert.deepEqual(r.result.plan.commands, ["Store Agenda 6 /NoConfirmation", "Assign Sequence 5 At Agenda 6"]);
  assert.equal(r.result.plan.properties[0].value, "No");
  assert.equal(r.result.plan.properties.at(-1).value, "Yes");
});

test("batch: entries in order with their own checks; a number in two items is refused up front", async () => {
  let r = await h.callJson("gma3_store_agenda", { date: "2026-12-24", sequence: 5, entries: [{ no: 1, time: "19:00" }, { no: 1, time: "20:00" }] });
  assert.equal(r.result.outcome, "failed");
  assert.match(r.text, /Agenda 1 is in more than one item/);
  assert.deepEqual(h.fake.commands, []);
  r = await h.callJson("gma3_store_agenda", { date: "2026-12-24", sequence: 5, entries: [{ no: 1, time: "19:00" }, { no: 2, mode: "sunset", macro: 3 }] });
  assert.equal(r.result.outcome, "succeeded", r.text);
  assert.equal(r.result.items.length, 2);
  assert.equal(c.entries.get(2)?.object, "Macro 3", "an item's own target wins over the default");
});

test("gma3_agenda reads the entries, whether the agenda runs, and the location with a factory warning", async () => {
  c.add(1, { NAME: "Doors", MODE: "Sunset", DAYLIGHTOFFSET: "-15m00.00" }, "Sequence 5");
  c.add(4, { NAME: "Off", COMMAND: "Off Sequence 5" });
  const r = await h.callJson("gma3_agenda", {});
  assert.equal(r.result.running, true);
  assert.equal(r.result.total, 2);
  assert.equal(r.result.entries[0].name, "Doors");
  assert.equal(r.result.entries[0].mode, "Sunset");
  assert.equal(r.result.entries[0].object, "Festoon Bars");
  assert.equal(r.result.entries[1].command, "Off Sequence 5");
  assert.equal(r.result.location.factory, true);
  assert.match(JSON.stringify(r.result.notes), /factory location/);
  const one = await h.callJson("gma3_agenda", { no: 4, detail: true });
  assert.equal(one.result.count, 1);
  assert.ok(one.result.entries[0].schema.includes("MINUTEINTERVAL"));
  const none = await h.callJson("gma3_agenda", { no: 9 });
  assert.match(none.result.error, /Agenda 9 does not exist/);
});
