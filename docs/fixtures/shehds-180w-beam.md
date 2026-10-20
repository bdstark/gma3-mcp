# SHEHDS 180 W beam: gobo, colour, prism and frost

What each wheel slot of the SHEHDS 180 W beam actually projects, from photos of one unit on a wall (2026-10-20).
The fixture type in the show (type 3 "180W Beam Moving Head", converted from the grandMA2 library) has the wheels
but not this: its gobo slots carry no images, and every colour slot reads white
([SU-19 probe](../probes/su-19-fixture-type-data-macos-2.5.1.md#wheels)). `gma3_patch_type_structure` reports that
as `slotColors: "unset"` and asks; this page is the answer.

- **Slot numbers.** Photo *n* is the type's slot *n* + 1: the type numbers slots from 1, its colour slot 1 is
  `open`, and photo 0 is open on both wheels. The counts match: 15 gobo slots on G1, 12 colour slots on C1.
- **Sizes** are the pattern's width as a share of the open beam, measured against a clock in the same shot.
- **Rotation** in the photos is wherever the gobo stopped and depends on how the fixture is hung, so it is not part
  of the description.

## Gobo wheel (G1)

| Photo | Slot | Name | Pattern | Size |
| --- | --- | --- | --- | --- |
| [0](shehds-180w-beam/gobo-00.jpg) | 1 | Open | Full round beam, hard edge | 100% |
| [1](shehds-180w-beam/gobo-01.jpg) | 2 | Reducer L | Solid round dot, hard edge | ~75% |
| [2](shehds-180w-beam/gobo-02.jpg) | 3 | Reducer M | Solid round dot, hard edge | ~60% |
| [3](shehds-180w-beam/gobo-03.jpg) | 4 | Reducer S | Solid round dot, hard edge | ~45% |
| [4](shehds-180w-beam/gobo-04.jpg) | 5 | Bar | One narrow slot with rounded ends, 4–5 times as long as wide | ~100% long |
| [5](shehds-180w-beam/gobo-05.jpg) | 6 | Asterisk | Six rounded spokes from a solid centre, 60° apart | ~80% |
| [6](shehds-180w-beam/gobo-06.jpg) | 7 | Bones | Three separate bars with a two-lobed knob on the outer end, 120° apart around a dark centre | ~75–80% |
| [7](shehds-180w-beam/gobo-07.jpg) | 8 | Wi-Fi | A solid dot with two quarter-circle bands around it, rounded ends | ~80% |
| [8](shehds-180w-beam/gobo-08.jpg) | 9 | Swirl 5 | Five separate curved blades around a dark centre, all curving the same way | ~75% |
| [9](shehds-180w-beam/gobo-09.jpg) | 10 | Curved Triangle | One solid triangle with inward-curved sides and rounded points | ~70% |
| [10](shehds-180w-beam/gobo-10.jpg) | 11 | Trefoil | Three separate rounded triangles pointing inward, 120° apart, like a radiation symbol | ~80% |
| [11](shehds-180w-beam/gobo-11.jpg) | 12 | Square Outline | Four separate bars with tapered ends forming a square around a dark centre | ~80% |
| [12](shehds-180w-beam/gobo-12.jpg) | 13 | Dot Cluster | One larger centre dot with six smaller dots in a hexagonal ring | ~80% |
| [13](shehds-180w-beam/gobo-13.jpg) | 14 | Petal Ring 6 | Six rounded-triangle petals pointing inward in a ring, nearly touching | ~70% |
| [14](shehds-180w-beam/gobo-14.jpg) | 15 | Daisy | A round centre dot with a ring of ten oval petals | ~80% |

The gobo 8 photo shows a faint second copy of the pattern up and to the left. It is a reflection in the optics, not
part of the gobo.

## Colour wheel (C1)

Names are what the colour looked like by eye. The hues were measured on the light spilling around the spot, because
the spot's centre is overexposed in every photo. The phone camera pushed every colour toward blue (open white came
out pale cyan), so the hues are a check on the names, not exact values. The RGB is a nominal swatch for the console,
chosen from the name and the measured hue.

| Photo | Slot | Name | Seen as | Measured hue | Swatch RGB (0–1) |
| --- | --- | --- | --- | --- | --- |
| [0](shehds-180w-beam/colour-00.jpg) | 1 | Open | The lamp's own cool white, the coolest of the three whites | white | 1, 1, 1 |
| [1](shehds-180w-beam/colour-01.jpg) | 2 | Green | Saturated green, bluer than slot 8 | ~143° | 0, 1, 0.25 |
| [2](shehds-180w-beam/colour-02.jpg) | 3 | Indigo | Deep blue leaning violet ("light purple" next to slot 7) | ~232–248° | 0.3, 0, 1 |
| [3](shehds-180w-beam/colour-03.jpg) | 4 | Neutral White | White slightly warmer than open: a light correction filter | white | 1, 0.95, 0.85 |
| [4](shehds-180w-beam/colour-04.jpg) | 5 | Cyan | Strong sky-blue cyan | ~205° | 0, 0.8, 1 |
| [5](shehds-180w-beam/colour-05.jpg) | 6 | Magenta | Magenta leaning purple | ~280° | 0.9, 0, 1 |
| [6](shehds-180w-beam/colour-06.jpg) | 7 | Blue | Medium blue, lighter than slot 3, no violet | ~220° | 0, 0.4, 1 |
| [7](shehds-180w-beam/colour-07.jpg) | 8 | Lime | Yellow-green, yellower than slot 2 | ~118–130° | 0.5, 1, 0 |
| [8](shehds-180w-beam/colour-08.jpg) | 9 | Yellow | Pure yellow, slightly lemon | ~61° | 1, 0.9, 0 |
| [9](shehds-180w-beam/colour-09.jpg) | 10 | Amber | Golden amber, between orange and yellow | ~36–40° | 1, 0.6, 0 |
| [10](shehds-180w-beam/colour-10.jpg) | 11 | Red | True red | ~0–3° | 1, 0, 0 |
| [11](shehds-180w-beam/colour-11.jpg) | 12 | Warm White | Clearly warm white: a stronger correction filter | ~55°, pale | 1, 0.85, 0.6 |

The type's channel sets name these `open`, `colour 1` … `colour 11`. On the 8-bit colour channel `colour 1` (slot 2,
green) is DMX 11–21.

## Prism

The beam has one prism, on the console's Beam tab, second encoder.

[Photo](shehds-180w-beam/prism.jpg): an 18-facet prism. With the open gobo it makes 18 round copies of the beam in two
rings, 12 outside and 6 inside, with a dark centre and no copy in the middle. The copies' edges show slight yellow
and blue fringes from the glass.

## Frost

The Beam tab's third encoder has three positions:

| Photo | Name | Seen as |
| --- | --- | --- |
| [0](shehds-180w-beam/frost-0.jpg) | Open | The hard-edged beam |
| [1](shehds-180w-beam/frost-1.jpg) | Frost | No edge left: a wide, soft wash with a brighter middle |
| [2](shehds-180w-beam/frost-2.jpg) | Light frost | The spot keeps its shape with a slightly softer edge; the photo shows magenta and cyan fringes on opposite sides |

The type has two effect wheels with media, E (2 slots) and E2 (3 slots). The counts suggest the prism (open, prism)
is E and the frost is E2, but that has not been checked against the type.

These names, swatches and the prism and frost notes have not been written to the show's fixture type yet.
