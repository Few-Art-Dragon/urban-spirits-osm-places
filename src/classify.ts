import { BLOCK_MASK_RES, SPAWN_CELL_RES, type PlaceType } from './shared';

import type { FeatureKind } from './tags';

/**
 * Resolution of the grid that measures shares: ~9 m cells, 343 children per spawn cell. The same
 * grid is the blocked-area mask the spawn uses, so a blocked measure cell is a blocked mask bit.
 */
export const MEASURE_RES = BLOCK_MASK_RES;
export const CHILDREN_PER_CELL = 7 ** (MEASURE_RES - SPAWN_CELL_RES);

/** Ground no spirit may stand on. */
export const BLOCKING_KINDS: ReadonlySet<FeatureKind> = new Set([
  'waterBody',
  'closed',
  'motorway',
  'road',
  'street',
  'rail',
]);

/**
 * Ground that also excludes a whole cell when there is enough of it. Streets only mask: a dense
 * block of houses is still a fine place to walk, however many streets cross it.
 */
const EXCLUDING_KINDS: readonly FeatureKind[] = ['waterBody', 'closed', 'motorway', 'road', 'rail'];

/** Blocked this much (water, closed areas, main roads, rails) → no spawn in the cell at all. */
const EXCLUDED_SHARE = 0.6;
/** Any water surface from here on makes a shore. */
const WATER_SHARE = 0.1;
const HISTORIC_SHARE = 0.1;
const PARK_SHARE = 0.3;

export type CellPlace = PlaceType | 'excluded';
/** Measure cells of each kind inside one spawn cell. */
export type CellCounts = Partial<Record<FeatureKind, number>>;

/**
 * Priority: excluded > water > historic area > park > historic point > urban. A park with a pond
 * is `water`, a cemetery in a park is `historic`, but one statue does not turn a park historic:
 * single points only lift plain city cells.
 */
export function classifyCell(counts: CellCounts): CellPlace {
  const share = (kind: FeatureKind) => (counts[kind] ?? 0) / CHILDREN_PER_CELL;
  let excluding = 0;
  for (const kind of EXCLUDING_KINDS) excluding += share(kind);
  if (excluding >= EXCLUDED_SHARE) return 'excluded';
  if (share('waterBody') >= WATER_SHARE || has(counts, 'waterway')) return 'water';
  if (share('historic') >= HISTORIC_SHARE) return 'historic';
  if (share('park') >= PARK_SHARE) return 'park';
  if (has(counts, 'historicPoint')) return 'historic';
  return 'urban';
}

function has(counts: CellCounts, kind: FeatureKind): boolean {
  return (counts[kind] ?? 0) > 0;
}
