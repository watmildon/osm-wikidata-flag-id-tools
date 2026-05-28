# OSM Flag Identifier

A set of mobile-friendly web pages for OpenStreetMap mappers working with
flags. Identify a flag you see in the field, copy the right OSM tags for
it, and help tidy up flag tagging on both OSM and Wikidata.

All flag imagery and metadata is powered by Wikidata — every image, label,
color, and dimension on this site comes from a Wikidata entity.

Flag data in OSM and on Wikidata is ripe for improvement! OSM
elements need QIDs, Wikidata flag entities are missing
images or colors, and entire categories of common flags don't have proper
Wikidata entries at all. It will be easy to spot lots of available work using the pages below. Every fix you commit improves the picture for everyone
downstream — this site, every other Wikidata consumer, and the next
mapper to walk past that flagpole.

The site is built around four pages, each with a specific job.

## [Identify a flag](https://watmildon.github.io/osm-wikidata-flag-id-tools/)

The main page. A filterable grid of every flag in the dataset (~1,500 and
counting). Use it when you're standing in front of a flagpole and need to
figure out what to tag.

Filter by:

- **Search** — name, description, or keyword (e.g. *crown*, *saltire*,
  *mountain*, *kufic*).
- **Colors** — pick one or more from a 13-color palette. AND semantics
  across colors (a flag must contain *all* selected colors to match).
- **Iconography** — star, cross, animal, plant, horizontal stripes, etc.
- **Shape** — rectangle, square, pennant, other.

Tap a flag tile to open its detail dialog. Tap **Copy tags** to copy a
clipboard-ready tag block like:

```
flag:type=national
flag:wikidata=Q42537
flag:name=United States
```

Paste it onto the flagpole element in your OSM editor.

Flags shown with a `?` placeholder and "no image" badge are real flags
whose Wikidata entity is missing a P18 image. You can still copy the tags,
and if you have a moment, follow through to fix Wikidata.

## [Curate a flag](https://watmildon.github.io/osm-wikidata-flag-id-tools/curate.html)

Reach this from the pencil icon on any flag's detail dialog, or visit
directly to walk through every flag missing iconography, colors, or shape.

The page presents one flag at a time with editable fields:

- **Display name** — what mappers should put in `flag:name`.
- **flag:type** — one of *national*, *regional*, *municipal*,
  *governmental*, *military*, *religious*, etc.
- **Colors** — multi-select swatch chips.
- **Iconography** — multi-select chips.
- **Shape** — single-select.

Press **Save & next** (or Enter) to commit and advance. Press **Skip** (or
`s`) to advance without saving. Edits collect in your browser's
localStorage as a sparse override set.

When you're done, click **Export overrides.json**. In Chrome/Edge the
file writes back directly to the repository's `data/overrides.json` (you
authorize the location once and the page remembers it). In Firefox/Safari
a file downloads instead — drop it into the repository manually.

Cleared edits and previously-committed values are pruned automatically
when the page loads, so your queue stays focused on real work.

## [Fix OSM tagging mistakes](https://watmildon.github.io/osm-wikidata-flag-id-tools/review.html)

A table of OSM elements that are using the wrong Wikidata QID for their
flag. Two sources of suggestions:

- **P163 mismatches** — a mapper tagged the country/organization QID
  instead of the dedicated "flag of X" QID. Wikidata's `P163 (flag)`
  property names the right one.
- **Redirected QIDs** — a mapper used a QID that has since been merged
  into another. Wikidata's `owl:sameAs` points to the canonical target.

Each row shows the bad QID, the suggested replacement (with thumbnail and
label), how many OSM elements are affected, and a map-pin button that
opens the affected elements in [overpass-turbo](https://overpass-turbo.eu/)
so you can fix them in place. Sorted by impact (OSM use count) descending.

## [Suggest Wikidata edits](https://watmildon.github.io/osm-wikidata-flag-id-tools/wikidata-suggestions.html)

Records this site has touched whose Wikidata entity could use a small
fix. Each section is collapsible.

- **Missing flag entity** — subjects (cities, organisations) that have a
  flag image attached via `P41` on their main Wikidata entity, but no
  dedicated "flag of X" entity exists for the flag itself. Until someone
  creates one, OSM mappers have nowhere correct to point
  `flag:wikidata=` at. Each row has buttons to open the subject on
  Wikidata and to create a new flag item.
- **Not classified as a flag** — a QID is in OSM as `flag:wikidata=` but
  Wikidata doesn't have `P31/P279*` reaching either *flag (Q14660)* or
  *flag design (Q69506823)*. Could be either side's bug: add a `P31`
  statement on Wikidata, or retag the OSM elements. Both paths offered.
- **Missing image** — flag entities with no `P18` image set on Wikidata.
  Add the image on Wikidata and it flows back into this site (and every
  other downstream consumer of Wikidata) on the next build.
- **Colors** — flags where the curated color list and Wikidata's `P462`
  statements disagree. Three sub-buckets: *we have colors, Wikidata
  doesn't* (just add `P462`), *count mismatch* (review which side is
  right), and *neither side has colors* (long-tail unclassified — best
  curated locally first, then pushed upstream).

Sorted by OSM usage count so the highest-impact fixes show first.

## Getting around

Every page has a back link to the identifier. The review and
wikidata-suggestions pages cross-link to each other so you can switch
between OSM-side and Wikidata-side fixes without going through the home
page.

## Sharing your curated edits

When you finish a curating session, the **Export overrides.json** button
gives you a file containing your changes merged on top of the live
`data/overrides.json`. The cleanest way to get those changes into the
project is to open a pull request against
[the repo](https://github.com/watmildon/osm-wikidata-flag-id-tools) —
drop your exported file in at `data/overrides.json` and GitHub will show a
clean per-flag diff that's easy to review.

Or just send a file to me.
