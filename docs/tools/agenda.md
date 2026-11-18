# Agenda (#147)

The grandMA3 Agenda runs a sequence, macro, plugin or command at a date and time, or at a twilight time (dawn,
sunrise, sunset, dusk) worked out from the console's location. For an installation this is how looks start at dusk and
stop at a fixed time without anyone at the console.

| Tool | What it does |
|---|---|
| `gma3_agenda` | Read-only. Lists the entries, whether the agenda runs, and the location twilight times are calculated for |
| `gma3_store_agenda` | Creates entries (or replaces one with `overwrite: true`), checks each step and reads every property back; also takes a list (batch form) |

There is no bridge change. The tools use the existing `object`, `objects`, `set` and `cmd` ops.

## Where the agenda lives

These facts come from a read-only probe of onPC 2.5.1 on 2026-11-17 and the 2.5 manual:

- **Entries:** `ShowData.Agendas` (class `Agendas`) holds the entries. Its `Running` property says whether the agenda runs at all.
- **One entry:** the `Agenda` keyword names one entry. The manual's examples are `Assign Sequence 1 At Agenda 1`, `Label Agenda 1 "Sunset"` and `Set Agenda 2 Property "Mode" "Dawn"`.
- **Location:** twilight times use the location in `Root.StationSettings.TimeConfig` (`Latitude`, `Longitude`, `TimeZone`, plus read-only `TodayDawn` … `TomorrowDusk`). You set it in Menu > Settings > Date and Time > Session Time.
- **Factory location:** the probe console still had the factory location, latitude 49.7878 / longitude 9.9361 (MA Lighting's home town), with time zone UTC-6, so its sunset read 09:34. Both tools warn while the location is the factory one: a twilight entry would fire at the wrong time.

## gma3_store_agenda

```jsonc
// Festoons on 15 minutes before sunset every day until Twelfth Night, off at 23:00.
{
  "date": "2026-11-18",
  "until_date": "2027-01-06",
  "entries": [
    { "no": 1, "name": "Festoons on", "mode": "sunset", "offset_minutes": -15, "sequence": 2, "action": "Go+" },
    { "no": 2, "name": "Festoons off", "time": "23:00", "sequence": 2, "action": "Off" }
  ]
}
```

| Field | Meaning |
|---|---|
| `no` | Entry number (required). A taken number is refused unless `overwrite: true`, which deletes the old entry first |
| `mode` | `absolute` (default; needs `time`) or `dawn`, `sunrise`, `sunset`, `dusk` (optional `offset_minutes`, negative = before; `time` is refused) |
| `date` | Start date `YYYY-MM-DD` (required) |
| `sequence` / `macro` / `plugin` / `command` | Exactly one: the object to run (number or name, with an optional `action` such as `Go+`, `Off`, `Toggle`), or a command line |
| `until_date`, `until_time` | Repeat up to this end |
| `every_minutes` | Repeat every n minutes (needs `until_date` or `until_time`) |
| `every_year` | Repeat every year |
| `valid_duration` | Seconds a missed entry may still fire (console off, agenda stopped) |
| `enabled` | Default true |
| `preview` | Read and plan only: returns the commands and property writes |

In the batch form, the other fields are defaults for every entry. An entry that names its own target replaces the
call's target, and its own twilight mode drops the call's `time`.

**Steps**
1. **Read:**
   - the Agendas collection: is the number free, and does the agenda run;
   - the target, which must exist and be of the right class;
   - for a twilight mode, the location;
   - the property names, from the replaced entry's or another entry's schema. If any property the request needs is missing, the request is refused before anything is sent.
2. **Replace:** with `overwrite`, `Delete Agenda n /NoConfirmation`, then read the slot back as free.
3. **Store:** `Store Agenda n /NoConfirmation`, then read that it is an agenda entry. If no entry existed before, the property names come from this new one; if one is missing, the new entry is deleted again.
4. **Disable, confirmed:** set `Enabled` to `No` and check that it reads `No`. A new entry starts with the console's date and time and may be enabled, so if the disable can't be confirmed the new entry is deleted again and nothing else is sent.

   Every cleanup delete is read back: the result says "deleted" only when the slot reads empty. If the entry is still there or the slot can't be read, the result warns that the entry may be live and needs checking now.
5. **Assign:** `Assign <target> At Agenda n`.
6. **Write:** set each property with the bridge's `set` op and check what each write reads back: mode, start date, start time or offset, valid duration, action or command, end date and time, minute interval, repeat every year, name. A write the console ignores, answers in a form the tool can't compare, or can't read back stops the entry, which stays disabled; the remaining steps are reported as skipped.
7. **Check before enabling:** while the entry is still disabled, read back the whole entry, including the `Object` by address. Anything that doesn't match, or can't be read, leaves it disabled. This check always runs, so an entry is never switched on unchecked.
8. **Enable:** only now, and only when `enabled` isn't false, set `Enabled` to `Yes` and check it reads `Yes`. The result also carries the planned next date and time.

## Not verified on a console

The probe show had no agenda entry, and the probe was read-only, so these come from the manual and the onPC 2.5.1
binary's strings, not from a live run:

- **Property names:** `Mode`, `StartDate`, `StartTime`, `DaylightOffset`, `ValidDuration`, `Enabled`, `Object`, `Action`, `Command`, `EndDate`, `EndTime`, `MinuteInterval` and `RepeatEveryYear`. The tool takes the names from an entry's schema and refuses when one is missing, so a different name means a refusal, never a write to the wrong property.
- **Value forms the tool sends:**
  - dates as `DD.MM.YYYY`;
  - times as `HH:MM:SS`;
  - the offset and valid duration as plain seconds.

  Every value is read back, and a form the console doesn't take shows as a mismatch.
- **Create command:** `Store Agenda n` as the way to create an entry.
- **Repeats:**
  - whether an end date alone repeats the entry every day;
  - how the day, week and month patterns (`DayRepeat`, `WeekRepeat`, `MonthRepeat`) are written. The tool does not set day-of-week patterns.
- **Actions:** the action names an agenda entry offers. They are sent and compared as text.

## Live test (throwaway show)

1. `gma3_agenda`: note the location and today's twilight times.
2. `gma3_store_agenda {no: 1, date: <today>, time: <now + 2 min>, macro: <a harmless macro>, preview: true}`, then the same without `preview`.
3. Check that the result matched, then `gma3_agenda {no: 1, detail: true}` for the real property names and the planned time.
4. Wait for the entry to fire, and check that the macro ran.
5. Try a `sunset` entry with `offset_minutes: -15` and an `until_date`, and compare its planned time with `TodaySunset`.
