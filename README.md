# Urban Spirits: place types from OpenStreetMap

Urban Spirits is a walking game: which spirits appear where depends on the kind of place.
The game derives that from [OpenStreetMap](https://www.openstreetmap.org/copyright) data, © OpenStreetMap contributors.

This repository is the method that turns an OpenStreetMap extract into the game's place types.
It is published to meet section 4.6 of the [Open Database License (ODbL)](https://opendatacommons.org/licenses/odbl/1-0/):
the game publicly uses a database derived from OpenStreetMap, and this is how that database is made.
The derived data itself is available under the ODbL.

## What it does

1. **Reads** an `.osm.pbf` extract (`src/read.ts`) and builds the geometry of ways and multipolygons.
2. **Classifies** features by their tags (`src/tags.ts`): parks and gardens, water, historic places,
   and the ground a spirit may not stand on (closed areas, roads, rails).
3. **Measures** every H3 cell at resolution 9 (~0.1 km²) on a finer grid (resolution 12, ~9 m)
   (`src/cells.ts`, `src/classify.ts`): the share of park, water and historic ground decides the
   cell's type — `park`, `water`, `historic` or `urban` — or `excluded` where nothing may spawn,
   plus a mask of the blocked ground inside the cell.
4. **Writes** the result (`src/places-file.ts`): gzipped text, a JSON header line, then
   `cell<TAB>value` per cell.

No other data source is mixed in.

## Run

```
npm install
npm start -- region.osm.pbf --region <name> --out region.places.gz
```

A city takes seconds to minutes; a country needs a lot of memory (see `--threads`).

## Licence

The code is under the MIT licence (`LICENSE`). Data produced from OpenStreetMap stays under the
ODbL and must credit © OpenStreetMap contributors.
