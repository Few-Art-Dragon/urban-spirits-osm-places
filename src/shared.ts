/** Place types a spawn cell can have. */
export const PLACE_TYPES = ['park', 'water', 'historic', 'urban'] as const;
export type PlaceType = (typeof PLACE_TYPES)[number];

/** H3 resolution of a spawn cell (~0.1 km²). */
export const SPAWN_CELL_RES = 9;
/** H3 resolution of the blocked-ground mask inside a spawn cell (~9 m). */
export const BLOCK_MASK_RES = 12;
