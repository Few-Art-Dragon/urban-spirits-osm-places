/**
 * OSM tags → what a feature means for the spawn.
 * One kind per feature: the first matching rule wins, so closed areas beat everything.
 */

export type Tags = ReadonlyMap<string, string>;

/** Polygons: their share of a cell decides its type. */
export type AreaKind = 'closed' | 'waterBody' | 'historic' | 'park';
/**
 * Lines: the cells they cross. `motorway` and `road` are wide (a corridor), `street` one cell
 * across; `path` blocks nothing. Players walk along every one but motorways and rails, and
 * spirits stand near them (ADR 0038).
 */
export type LineKind = 'motorway' | 'road' | 'street' | 'path' | 'rail' | 'waterway';
/** Single nodes that make a whole cell interesting. */
export type PointKind = 'historicPoint';

export type FeatureKind = AreaKind | LineKind | PointKind;

// Dangerous or off-limits for walkers: the spawn must not send players there.
const CLOSED_LANDUSE = new Set([
  'military',
  'railway',
  'construction',
  'landfill',
  'quarry',
  'industrial',
]);
/** Behind a fence and not for strangers; around children a lingering player is unwelcome. */
const CLOSED_AMENITY = new Set(['prison', 'school', 'kindergarten', 'hospital']);
const CLOSED_POWER = new Set(['substation', 'plant']);
const NO_ENTRY = new Set(['private', 'no']);
const WATER_LANDUSE = new Set(['reservoir', 'basin']);
const WATER_WATERWAY = new Set(['riverbank', 'dock']);
const PARK_LEISURE = new Set(['park', 'garden', 'nature_reserve']);
const PARK_LANDUSE = new Set(['forest', 'recreation_ground']);
/**
 * Carriageways: a spirit must not stand where cars drive. Main roads are wide and
 * block a corridor; plain residential streets block one mask cell across. Pavements are not
 * separate here, living streets, pedestrian zones, paths and service ways stay walkable.
 */
const MOTORWAYS = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link']);
const MAIN_ROADS = new Set([
  'primary',
  'primary_link',
  'secondary',
  'secondary_link',
  'tertiary',
  'tertiary_link',
]);
const STREETS = new Set(['residential', 'unclassified', 'road']);
/** Ways on foot, whether mapped apart from the street or as the street itself. */
const PATHS = new Set([
  'footway',
  'path',
  'pedestrian',
  'living_street',
  'steps',
  'cycleway',
  'bridleway',
  'track',
  'service',
]);
const MAIN_RAIL = new Set(['rail', 'light_rail']);
/** Rivers and canals make a shore; streams and ditches are too small to notice. */
const BIG_WATERWAYS = new Set(['river', 'canal']);
/**
 * Historic nodes worth a visit. Berlin alone has thousands of `memorial=stolperstein` plaques:
 * counting them would make the whole centre `historic`.
 */
const HISTORIC_POINTS = new Set([
  'monument',
  'memorial',
  'castle',
  'ruins',
  'archaeological_site',
  'city_gate',
  'citywalls',
  'fort',
  'palace',
  'manor',
  'monastery',
  'church',
  'tower',
]);
const MINOR_MEMORIALS = new Set(['stolperstein', 'plaque', 'blue_plaque']);

export function areaKind(tags: Tags): AreaKind | undefined {
  const landuse = tags.get('landuse');
  if (
    (landuse && CLOSED_LANDUSE.has(landuse)) ||
    isSet(tags.get('military')) ||
    tags.get('aeroway') === 'aerodrome' ||
    CLOSED_AMENITY.has(tags.get('amenity') ?? '') ||
    CLOSED_POWER.has(tags.get('power') ?? '') ||
    NO_ENTRY.has(tags.get('access') ?? '')
  ) {
    return 'closed';
  }
  const waterway = tags.get('waterway');
  if (
    tags.get('natural') === 'water' ||
    (waterway && WATER_WATERWAY.has(waterway)) ||
    (landuse && WATER_LANDUSE.has(landuse))
  ) {
    return 'waterBody';
  }
  // No rule for `man_made=bridge`: in Berlin most of them carry the S-Bahn over streets. A bridge
  // over a river is already a shore through the river itself.
  if (
    isMajorHistoric(tags) ||
    landuse === 'cemetery' ||
    tags.get('amenity') === 'grave_yard' ||
    tags.get('amenity') === 'place_of_worship'
  ) {
    return 'historic';
  }
  const leisure = tags.get('leisure');
  if (
    (leisure && PARK_LEISURE.has(leisure)) ||
    (landuse && PARK_LANDUSE.has(landuse)) ||
    tags.get('natural') === 'wood'
  ) {
    return 'park';
  }
  return undefined;
}

/** Lines below ground do not block the surface and do not make a shore. */
export function lineKind(tags: Tags): LineKind | undefined {
  if (isUnderground(tags)) return undefined;
  const highway = tags.get('highway');
  if (highway && MOTORWAYS.has(highway)) return 'motorway';
  if (highway && MAIN_ROADS.has(highway)) return 'road';
  if (highway && STREETS.has(highway)) return 'street';
  // A driveway or a path closed to the public leads nowhere a player may go.
  if (highway && PATHS.has(highway)) {
    return NO_ENTRY.has(tags.get('access') ?? '') || tags.get('foot') === 'no' ? undefined : 'path';
  }
  const railway = tags.get('railway');
  if (railway && MAIN_RAIL.has(railway)) return 'rail';
  const waterway = tags.get('waterway');
  if (waterway && BIG_WATERWAYS.has(waterway)) return 'waterway';
  return undefined;
}

export function pointKind(tags: Tags): PointKind | undefined {
  const historic = tags.get('historic');
  if (historic && HISTORIC_POINTS.has(historic) && isMajorHistoric(tags)) return 'historicPoint';
  if (tags.get('amenity') === 'place_of_worship') return 'historicPoint';
  return undefined;
}

/**
 * A closed way is an area unless tagged otherwise; highways and barriers are lines even when
 * closed (roundabouts, fences around a park).
 */
export function closedWayIsArea(tags: Tags): boolean {
  if (tags.get('area') === 'no') return false;
  if (tags.get('area') === 'yes') return true;
  return !tags.has('highway') && !tags.has('barrier');
}

export function isMultipolygon(tags: Tags): boolean {
  return tags.get('type') === 'multipolygon';
}

function isMajorHistoric(tags: Tags): boolean {
  if (!isSet(tags.get('historic'))) return false;
  const memorial = tags.get('memorial');
  return !(memorial && MINOR_MEMORIALS.has(memorial));
}

function isUnderground(tags: Tags): boolean {
  const layer = Number(tags.get('layer') ?? 0);
  return isSet(tags.get('tunnel')) || tags.get('location') === 'underground' || layer < 0;
}

function isSet(value: string | undefined): boolean {
  return value !== undefined && value !== 'no';
}
