# OSM Flag Identifier

A set of mobile-friendly web pages for OpenStreetMap mappers working with
flags. Identify a flag you see in the field, copy the right OSM tags for
it, and help tidy up flag tagging on both OSM and Wikidata.

Flag data in OSM and on Wikidata is ripe for improvement! OSM
elements need QIDs, Wikidata flag entities are missing
images or colors, and entire categories of common flags don't have proper
Wikidata entries at all. It will be easy to spot lots of available work using the pages below. Every fix you commit improves the picture for everyone
downstream — this site, every other Wikidata consumer, and the next
mapper to walk past that flagpole.

The site has one mapper-facing page and a back office
hub linking to a handful of curation and cleanup tools.

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

## [Back office](https://watmildon.github.io/osm-wikidata-flag-id-tools/backoffice.html)

Everything below is maintenance work: curating attributes for this site,
fixing OSM tags that point at the wrong Wikidata entity, and filling
Wikidata gaps. The back office page is the hub that links to all of it.

Edits made on any of the backoffice pages is shared across them. Classify colors on one page, fill in a description on another, and they all export together as a single
`overrides.json`.

### **Look's Good Button**

Right now there's lots of metadata about flags from a mishmosh of sources and tools. It would be good to make sure we have eyeballs on each piece. Even scrolling through and sending a "these look good" file is very helpful!

### Curate this site's data

- **[Curate flag attributes](https://watmildon.github.io/osm-wikidata-flag-id-tools/curate.html)** —
  One-flag-at-a-time queue editor for display name, flag:type, colors,
  iconography, shape, and description.
- **[Describe flags](https://watmildon.github.io/osm-wikidata-flag-id-tools/describe.html)** —
  Browse every flag with its current description in a list
- **[Review colors](https://watmildon.github.io/osm-wikidata-flag-id-tools/review-colors.html)** —
  Browse every flag with its current palette as chip toggles.
- **[Review iconography](https://watmildon.github.io/osm-wikidata-flag-id-tools/review-icons.html)** —
  Browse every flag and review the 22-icon iconography
  vocabulary (text, animal, cross, stars, stripes, etc.).

When you're done, click **Export overrides.json**. Submit a Pull Request or send me the file for merging.

### Fix OSM tagging mistakes

The **[Review OSM-side fixes](https://watmildon.github.io/osm-wikidata-flag-id-tools/review.html)**
page is a table of OSM elements that are using the wrong Wikidata QID
for their flag. Two sources of suggestions:

- **P163 mismatches** — a mapper tagged the country/organization QID
  instead of the dedicated "flag of X" QID. Wikidata's `P163 (flag)`
  property names the right one.
- **Redirected QIDs** — a mapper used a QID that has since been merged
  into another. Wikidata's `owl:sameAs` points to the canonical target.

Each row shows the bad QID, the suggested replacement (with thumbnail and
label), how many OSM elements are affected, and a map-pin button that
opens the affected elements in [overpass-turbo](https://overpass-turbo.eu/)
so you can fix them in place. Sorted by impact (OSM use count) descending.

### Fix Wikidata

- **[Suggested Wikidata edits](https://watmildon.github.io/osm-wikidata-flag-id-tools/wikidata-suggestions.html)** —
  Aggregated Wikidata-side cleanup work, in collapsible sections:
  - *Missing flag entity* — subjects (cities, organisations) that have
    a flag image attached via `P41` on their main Wikidata entity, but
    no dedicated "flag of X" entity exists yet. Until someone creates
    one, OSM mappers have nowhere correct to point `flag:wikidata=` at.
  - *Not classified as a flag* — a QID is in OSM as `flag:wikidata=`
    but Wikidata doesn't have `P31/P279*` reaching *flag
    (Q14660)*, *flag design (Q69506823)*, or *flag or coat of arms
    (Q17335294)*. Could be either side's bug: add a `P31` statement
    on Wikidata, or retag the OSM elements. These records are
    hidden from the main identifier so mappers don't reinforce
    bad tags by copying them.
  - *Missing image* — flag entities with no `P18` image set on
    Wikidata. Add the image on Wikidata and it flows back into this
    site after the next redeploy.
  - *Colors* — flags where the curated color list and Wikidata's
    `P462` statements disagree. Three sub-buckets: *we have colors,
    Wikidata doesn't* (just add `P462`), *count mismatch* (review
    which side is right), and *neither side has colors*. 
    
    **WARNING**: our color model and the one expected on Wikidata will inherently have conflicts
- **[Create flag entities](https://watmildon.github.io/osm-wikidata-flag-id-tools/create-flag-entities.html)** —
  Multi-select review for the auto-detected subjects with a `P41` flag
  image but no dedicated "flag of X" entity (`P163`). Pick the ones
  you've verified and the page generates a QuickStatements batch you can
  paste in to create them.

All Wikidata suggestion lists are sorted by OSM usage count so the
highest-impact fixes show first.

## Sharing your curated edits

When you finish a curating session, the **Export overrides.json** button
gives you a file containing your changes merged on top of the live
`data/overrides.json`. The cleanest way to get those changes into the
project is to open a pull request against
[the repo](https://github.com/watmildon/osm-wikidata-flag-id-tools) —
drop your exported file in at `data/overrides.json` and GitHub will show a
clean per-flag diff that's easy to review.

Or just send a file to me.
