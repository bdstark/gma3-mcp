#!/usr/bin/env python3
"""Flag GDTF shutter and dimmer sets that the grandMA3 3D view draws wrongly.

The 3D view draws a beam from the physical value, not the DMX value. A shutter or dimmer set named
"Open" (or "On", "Full") that starts at physical 0 renders closed, so the fixture shows no beam even
though real output is fine (NO BEAM). A "Closed" set above physical 0 renders a faint beam (FAINT).

A set that gives no PhysicalFrom/PhysicalTo of its own is read the way the grandMA3 onPC 2.5 3D view drew it:
interpolated linearly over its channel function's range at the set's DMX values. The GDTF spec says such a set
inherits the function's PhysicalFrom/PhysicalTo, but that reading does not match the console: it would put every
dimmer "Open" set at DMX 255 of a 0-1 function at physical 0, and the Sentinel Spot Q60's shutter "Open" set at
DMX 4 of a 0-7 function at 0, yet both draw a beam (the Q60's interpolates to 0.57).

Usage: check_gdtf_open.py FILE.gdtf [FILE.gdtf ...]
Exit status 1 when any NO BEAM set is found; FAINT alone exits 0.
"""
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

OPEN = re.compile(r"\b(open|on|full)\b", re.I)
CLOSED = re.compile(r"\b(closed?|off|blackout)\b", re.I)
CHECKED = re.compile(r"^(Shutter\d*|Dimmer)$")


def dmx(value, size):
    """A GDTF DMXValue at the channel's resolution. 'v/n' mirrors its bytes ('255/1' on 2 bytes -> 65535,
    '128/1' -> 32896); 'v/ns' shifts them ('255/1s' -> 65280). A value finer than the channel drops low bytes."""
    raw, _, own = value.partition("/")
    shift = own.endswith("s")
    own = int(own.rstrip("s") or 1)
    v = int(raw)
    if own >= size:
        return v >> 8 * (own - size)
    if shift:
        return v << 8 * (size - own)
    pattern = v.to_bytes(own, "big")
    return int.from_bytes((pattern * size)[:size], "big")


def physical_at(func, start, end, value):
    lo, hi = float(func.get("PhysicalFrom", 0)), float(func.get("PhysicalTo", 1))
    return lo if end <= start else lo + (hi - lo) * (value - start) / (end - start)


def check_logical(mode, logical, size):
    """Check one logical channel's functions; functions behind different mode-master ranges overlap,
    so each mode-master range is its own run of DMX ranges."""
    flagged = []
    top = 256 ** size - 1
    runs = {}
    for func in logical.findall("ChannelFunction"):
        key = (func.get("ModeMaster"), func.get("ModeFrom"), func.get("ModeTo"))
        runs.setdefault(key, []).append(func)
    for funcs in runs.values():
        starts = [dmx(f.get("DMXFrom", "0/1"), size) for f in funcs]
        for i, func in enumerate(funcs):
            if not CHECKED.match(func.get("Attribute", "")):
                continue  # Shutter1Strobe and the like: physical values are rates, not light
            start = starts[i]
            end = starts[i + 1] - 1 if i + 1 < len(funcs) else top
            sets = func.findall("ChannelSet")
            if not sets:
                sets, names = [func], [func.get("Name", "")]
            else:
                names = [s.get("Name", "") for s in sets]
            values = [dmx(s.get("DMXFrom", func.get("DMXFrom", "0/1")), size) for s in sets]
            for j, s in enumerate(sets):
                name = names[j]
                if not name:
                    continue
                first = values[j]
                last = values[j + 1] - 1 if j + 1 < len(sets) else end
                own = s is not func
                lo = float(s.get("PhysicalFrom")) if own and s.get("PhysicalFrom") else physical_at(func, start, end, first)
                hi = float(s.get("PhysicalTo")) if own and s.get("PhysicalTo") else physical_at(func, start, end, last)
                where = (f'{mode.get("Name")}: {logical.get("Attribute")} "{func.get("Name")}" / "{name}" '
                         f"at DMX {first}-{last}")
                if OPEN.search(name) and lo <= 0:
                    flagged.append(f"NO BEAM  {where} starts at physical {lo:g}; give it a physical value above 0")
                elif CLOSED.search(name) and max(lo, hi) > 0:
                    flagged.append(f"FAINT    {where} reaches physical {max(lo, hi):g}; a closed set should stay at 0")
    return flagged


def check(path):
    with zipfile.ZipFile(path) as z:
        root = ET.fromstring(z.read("description.xml"))
    flagged = []
    for mode in root.iter("DMXMode"):
        for channel in mode.iter("DMXChannel"):
            offset = channel.get("Offset") or ""
            size = len(offset.split(",")) if offset and offset != "None" else 1
            for logical in channel.findall("LogicalChannel"):
                flagged += check_logical(mode, logical, size)
    return flagged


def main(paths):
    bad = False
    for path in paths:
        found = check(path)
        print(f"{path}: {'ok' if not found else str(len(found)) + ' flagged'}")
        for line in found:
            print("  " + line)
        bad = bad or any(line.startswith("NO BEAM") for line in found)
    return 1 if bad else 0


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    sys.exit(main(sys.argv[1:]))
