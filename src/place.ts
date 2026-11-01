import { BLOCK_MASK_RES, PLACE_TYPES, type PlaceType } from './shared';

const EXCLUDED = 'excluded';
/** Cells without an import result count as plain city. */
const DEFAULT_PLACE_TYPE: PlaceType = 'urban';

/** What the import says about a spawn cell. */
export interface PlaceInfo {
  /** `excluded` cells (mostly water, closed areas, fast roads, rails) never spawn. */
  place: PlaceType | typeof EXCLUDED;
  /** Blocked children at BLOCK_MASK_RES inside a spawning cell; 0n = none. */
  blocked: bigint;
}

/** 7^(12−9) = 343 bits at most. */
const MASK_HEX = /^[0-9a-f]{1,86}$/;

/** Stored mask: `<res>:<hex>`. */
export function encodeMask(blocked: bigint): string {
  return `${String(BLOCK_MASK_RES)}:${blocked.toString(16)}`;
}

export function decodeMask(value: string | null | undefined): bigint {
  const [res, hex] = value?.split(':') ?? [];
  if (res !== String(BLOCK_MASK_RES) || !hex || !MASK_HEX.test(hex)) return 0n;
  return BigInt(`0x${hex}`);
}

/** Stored value: `park`, or `park|<mask>` when parts of the cell are blocked. */
export function encodePlace({ place, blocked }: PlaceInfo): string {
  return blocked === 0n || place === EXCLUDED ? place : `${place}|${encodeMask(blocked)}`;
}

export function decodePlace(value: string | null | undefined): PlaceInfo {
  const [place, mask] = value?.split('|') ?? [];
  return { place: parsePlaceType(place), blocked: decodeMask(mask) };
}

function parsePlaceType(value: string | undefined): PlaceType | typeof EXCLUDED {
  if (value === EXCLUDED) return EXCLUDED;
  return PLACE_TYPES.find((p) => p === value) ?? DEFAULT_PLACE_TYPE;
}
