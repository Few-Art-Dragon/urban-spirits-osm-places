import { SPAWN_CELL_RES } from './shared';
import {
  cellToBoundary,
  cellToChildPos,
  cellToLatLng,
  cellToParent,
  gridDisk,
  gridPathCells,
  latLngToCell,
  POLYGON_TO_CELLS_FLAGS,
  polygonToCells,
  polygonToCellsExperimental,
} from 'h3-js';

import type { PlaceInfo } from './place';
import {
  BLOCKING_KINDS,
  CHILDREN_PER_CELL,
  classifyCell,
  MEASURE_RES,
  type CellCounts,
} from './classify';
import type { AreaKind, FeatureKind, LineKind, PointKind } from './tags';

/** [lat, lng], the order h3-js expects. */
export type LatLng = [number, number];

export type Feature =
  | { type: 'area'; kind: AreaKind; outers: LatLng[][]; inners: LatLng[][] }
  | { type: 'line'; kind: LineKind; points: LatLng[] }
  | { type: 'point'; kind: PointKind; point: LatLng };

/**
 * Splits each kind's cells by the res-3 cell they lie in (~12 000 km²): a JS Set holds at most
 * 2^24 entries, and the forests of a country are tens of millions of measure cells (Belarus,
 * 11.10). A cell always falls into the same part, so overlaps are still counted once.
 */
const SHARD_RES = 3;

/** Every mask bit of a spawn cell. */
const ALL_BITS = (1n << BigInt(CHILDREN_PER_CELL)) - 1n;

/** Measure cells as bits of their spawn cell (bit = child position), like the blocked mask. */
export type Bits = Map<string, bigint>;

/**
 * How far (metres) from a way's centre line a mask cell's centre may lie for a spirit to stand in
 * it: the cell adds ~9 m, so a spirit is at most ~25 m from where the player walks, within the
 * catch radius even behind a fence (ADR 0038). Pavements lie a few metres off a street's line,
 * ~10 m off a main road's.
 */
const WALK_BAND_M: Partial<Record<LineKind, number>> = { path: 16, street: 20, road: 26 };
/** Rings of mask cells (~16 m apart) that hold the widest band. */
const BAND_RINGS = 2;
const METRES_PER_DEGREE = 111_320;

/** `walk`: near a way players walk along; not a feature, a band around some (WALK_BAND_M). */
type CoverKind = FeatureKind | 'walk';

type Shards<T> = Map<CoverKind, Map<string, Map<string, T>>>;

/** Plain Maps and bigints: they cross to another thread as they are (structured clone). */
export interface CoverageParts {
  fine: Shards<bigint>;
  full: Shards<true>;
}

/**
 * Collects the measure cells (BLOCK_MASK_RES) each kind covers, as bits: overlapping features of
 * one kind (a park inside a park) must not count twice, and a bit costs nothing where a cell id
 * string took ~100 bytes (14 GB for Belarus, 12.10). Spawn cells a kind covers whole are kept as
 * such: the inside of a country's forests is hundreds of millions of measure cells.
 */
export class Coverage {
  private readonly fine: Shards<bigint> = new Map();
  private readonly full: Shards<true> = new Map();

  add(feature: Feature): void {
    const cover = featureCover(feature);
    for (const [cell, bits] of cover.fine) this.addFine(feature.kind, cell, bits);
    for (const cell of cover.full) shardOf(this.full, feature.kind, cell).set(cell, true);
    const band = feature.type === 'line' ? WALK_BAND_M[feature.kind] : undefined;
    if (band === undefined || feature.type !== 'line') return;
    for (const [cell, bits] of toBits(bandCells(feature.points, band))) {
      this.addFine('walk', cell, bits);
    }
  }

  /** What another Coverage needs to take this one in (a worker's share, import.ts). */
  parts(): CoverageParts {
    return { fine: this.fine, full: this.full };
  }

  merge({ fine, full }: CoverageParts): void {
    for (const [kind, shards] of fine) {
      for (const cells of shards.values()) {
        for (const [cell, bits] of cells) this.addFine(kind, cell, bits);
      }
    }
    for (const [kind, shards] of full) {
      for (const cells of shards.values()) {
        for (const cell of cells.keys()) shardOf(this.full, kind, cell).set(cell, true);
      }
    }
  }

  private addFine(kind: CoverKind, cell: string, bits: bigint): void {
    const cells = shardOf(this.fine, kind, cell);
    cells.set(cell, (cells.get(cell) ?? 0n) | bits);
  }

  /**
   * Every spawn cell touched by any feature, with its type and blocked mask. Plain `urban` cells
   * without blocked ground are left out: a missing entry means exactly that. Where a cell has ways
   * to walk along, ground far from them is blocked too; a cell without any keeps all its ground.
   */
  places(): Map<string, PlaceInfo> {
    const counts = new Map<string, CellCounts>();
    const masks = new Map<string, bigint>();
    const walks = new Map<string, bigint>();
    const note = (kind: CoverKind, cell: string, bits: bigint) => {
      if (kind === 'walk') {
        walks.set(cell, bits);
        if (!counts.has(cell)) counts.set(cell, {});
        return;
      }
      counts.set(cell, { ...counts.get(cell), [kind]: bitCount(bits) });
      if (BLOCKING_KINDS.has(kind)) masks.set(cell, (masks.get(cell) ?? 0n) | bits);
    };
    for (const [kind, shards] of this.fine) {
      for (const cells of shards.values()) {
        for (const [cell, bits] of cells) {
          if (!shardOf(this.full, kind, cell).has(cell)) note(kind, cell, bits);
        }
      }
    }
    for (const [kind, shards] of this.full) {
      for (const cells of shards.values())
        for (const cell of cells.keys()) note(kind, cell, ALL_BITS);
    }
    const places = new Map<string, PlaceInfo>();
    for (const [cell, entry] of counts) {
      const place = classifyCell(entry);
      const walk = walks.get(cell);
      const far = walk === undefined ? 0n : ALL_BITS & ~walk;
      const blocked = place === 'excluded' ? 0n : (masks.get(cell) ?? 0n) | far;
      if (place !== 'urban' || blocked !== 0n) places.set(cell, { place, blocked });
    }
    return places;
  }
}

function shardOf<T>(shards: Shards<T>, kind: CoverKind, cell: string): Map<string, T> {
  let byShard = shards.get(kind);
  if (!byShard) {
    byShard = new Map();
    shards.set(kind, byShard);
  }
  const key = cellToParent(cell, SHARD_RES);
  let cells = byShard.get(key);
  if (!cells) {
    cells = new Map();
    byShard.set(key, cells);
  }
  return cells;
}

function bitCount(bits: bigint): number {
  let count = 0;
  for (const digit of bits.toString(2)) if (digit === '1') count += 1;
  return count;
}

/** Measure cells grouped by spawn cell. */
export function toBits(cells: Iterable<string>, into: Bits = new Map()): Bits {
  for (const cell of cells) {
    const parent = cellToParent(cell, SPAWN_CELL_RES);
    const bit = 1n << BigInt(cellToChildPos(cell, SPAWN_CELL_RES));
    into.set(parent, (into.get(parent) ?? 0n) | bit);
  }
  return into;
}

/** Measure cells of a feature, and spawn cells it covers whole (their measure cells implied). */
export interface Cover {
  fine: Bits;
  full: Iterable<string>;
}

export function featureCover(feature: Feature): Cover {
  switch (feature.type) {
    case 'point':
      return {
        fine: toBits([latLngToCell(feature.point[0], feature.point[1], MEASURE_RES)]),
        full: [],
      };
    case 'line':
      // A main road with its lanes is wider than one mask cell: block its neighbours too.
      return {
        fine: toBits(
          feature.kind === 'road' || feature.kind === 'motorway'
            ? widen(lineCells(feature.points))
            : lineCells(feature.points),
        ),
        full: [],
      };
    case 'area':
      return areaCover(feature.outers, feature.inners, {
        touching: BLOCKING_KINDS.has(feature.kind),
      });
  }
}

/** A piece of an area keeps at most this many points: H3's work grows with cells × points. */
const PIECE_POINTS = 256;
/** Pieces stop splitting at this size (degrees of latitude), however many points they hold. */
const PIECE_MIN = 0.002;
/**
 * Room around a piece (degrees of latitude): more than a spawn cell across (~0.4 km) and what its
 * measure cells poke out, so every cell a piece owns is judged on uncut rings.
 */
const MARGIN = 0.008;
/** An area whose box is smaller than this (both ways, ~1 km) goes to areaCells whole. */
const SMALL = 0.01;

interface Piece {
  outers: LatLng[][];
  inners: LatLng[][];
}

/** Pieces as a quadtree: a cell belongs to the piece its centre falls in. */
interface Node {
  box: Box;
  piece?: Piece;
  parts?: Node[];
}

/**
 * The same cells as areaCells without listing the inside of a large area: spawn cells wholly
 * inside it and touched by no hole come back as `full`; measure cells are worked out only in the
 * spawn cells along the edge. H3 never sees a whole large ring: the area is cut into pieces of a
 * few hundred points (a lake of 1 862 points took H3 8 s whole, Belarus 12.10).
 */
export function areaCover(
  outers: readonly LatLng[][],
  inners: readonly LatLng[][],
  options: { touching?: boolean } = {},
): Cover {
  const bounds = boxOf(rings(outers));
  if (!bounds || isSmall(bounds)) {
    return { fine: toBits(areaCells(outers, inners, options)), full: [] };
  }

  const root = split(grow(bounds, 2), rings(outers), rings(inners));
  const inside = new Set<string>();
  const touched = new Set<string>();
  const holed = new Set<string>();
  for (const { box, piece } of leaves(root)) {
    const owned = (cell: string) => owns(box, cell);
    for (const ring of piece.outers) {
      for (const cell of spawnCells(ring, POLYGON_TO_CELLS_FLAGS.containmentFull)) {
        if (owned(cell)) inside.add(cell);
      }
      for (const cell of spawnCells(ring, POLYGON_TO_CELLS_FLAGS.containmentOverlapping)) {
        if (owned(cell)) touched.add(cell);
      }
    }
    for (const ring of piece.inners) {
      for (const cell of spawnCells(ring, POLYGON_TO_CELLS_FLAGS.containmentOverlapping)) {
        if (owned(cell)) holed.add(cell);
      }
    }
  }
  for (const cell of holed) inside.delete(cell);
  // Measure cells poke a little out of their spawn cell; with the neighbours inside too, none of
  // them can reach past the edge or into a hole.
  const full = new Set<string>();
  for (const cell of inside)
    if (gridDisk(cell, 1).every((near) => inside.has(near))) full.add(cell);

  // Measure cells of a spawn cell next to a touched one may reach in: look one cell further.
  const edge = new Set<string>();
  for (const cell of touched)
    for (const near of gridDisk(cell, 1)) if (!full.has(near)) edge.add(near);
  const fine: Bits = new Map();
  for (const cell of edge) {
    const piece = pieceAt(root, cellToLatLng(cell));
    if (!piece) continue;
    const box = cellBox(cell);
    const local = areaCells(clipAll(piece.outers, box), clipAll(piece.inners, box), {
      ...options,
      tiny: false,
    });
    const own = [...local].filter((child) => cellToParent(child, SPAWN_CELL_RES) === cell);
    toBits(own, fine);
  }
  // A ring smaller than a measure cell inside a large area still counts, as in areaCells.
  if (!options.touching) {
    for (const ring of rings(outers)) {
      const box = boxOf([ring]);
      if (box && isSmall(box) && polygonToCells(ring, MEASURE_RES).length === 0) {
        toBits([centreCell(ring)], fine);
      }
    }
  }
  return { fine, full };
}

function split(box: Box, outers: readonly LatLng[][], inners: readonly LatLng[][]): Node {
  const room = grow(box, 1);
  const piece = { outers: clipAll(outers, room), inners: clipAll(inners, room) };
  if (piece.outers.length === 0) return { box };
  const points = [...piece.outers, ...piece.inners].reduce((sum, ring) => sum + ring.length, 0);
  const [south, west, north, east] = box;
  if (points <= PIECE_POINTS || north - south < PIECE_MIN) return { box, piece };
  const lat = (south + north) / 2;
  const lng = (west + east) / 2;
  const quarters: Box[] = [
    [south, west, lat, lng],
    [south, lng, lat, east],
    [lat, west, north, lng],
    [lat, lng, north, east],
  ];
  return { box, parts: quarters.map((quarter) => split(quarter, piece.outers, piece.inners)) };
}

function* leaves(node: Node): Generator<{ box: Box; piece: Piece }> {
  if (node.piece) yield { box: node.box, piece: node.piece };
  for (const part of node.parts ?? []) yield* leaves(part);
}

function pieceAt(node: Node, point: LatLng): Piece | undefined {
  if (!inBox(node.box, point)) return undefined;
  if (node.piece) return node.piece;
  for (const part of node.parts ?? []) {
    const piece = pieceAt(part, point);
    if (piece) return piece;
  }
  return undefined;
}

/** Half-open, so that a centre on a shared side belongs to one piece only. */
function inBox([south, west, north, east]: Box, [lat, lng]: LatLng): boolean {
  return lat >= south && lat < north && lng >= west && lng < east;
}

function owns(box: Box, cell: string): boolean {
  return inBox(box, cellToLatLng(cell));
}

function clipAll(all: readonly LatLng[][], box: Box): LatLng[][] {
  return (
    all
      .map((ring) => clipRing(ring, box))
      // A ring running along the box edge clips to a line, which H3 refuses: it holds no cell.
      .filter((ring) => ring.length >= 3 && area(ring) !== 0)
  );
}

function rings(all: readonly LatLng[][]): LatLng[][] {
  return all.filter((ring) => ring.length >= 3);
}

function spawnCells(ring: LatLng[], flags: string): string[] {
  return polygonToCellsExperimental(ring, SPAWN_CELL_RES, flags);
}

function boxOf(all: readonly LatLng[][]): Box | undefined {
  const points = all.flat();
  if (points.length === 0) return undefined;
  const lats = points.map((p) => p[0]);
  const lngs = points.map((p) => p[1]);
  return [Math.min(...lats), Math.min(...lngs), Math.max(...lats), Math.max(...lngs)];
}

/** A degree of longitude shrinks towards the poles; spans are compared in degrees of latitude. */
function lngScale([south, , north]: Box): number {
  return Math.max(Math.cos((Math.max(Math.abs(south), Math.abs(north)) * Math.PI) / 180), 0.05);
}

function isSmall(box: Box): boolean {
  return box[2] - box[0] < SMALL && (box[3] - box[1]) * lngScale(box) < SMALL;
}

/** The box with `times` margins added on every side. */
function grow(box: Box, times: number): Box {
  const lat = MARGIN * times;
  const lng = lat / lngScale(box);
  return [box[0] - lat, box[1] - lng, box[2] + lat, box[3] + lng];
}

/** [south, west, north, east] around a spawn cell, with room for measure cells poking out. */
type Box = [number, number, number, number];

function cellBox(cell: string): Box {
  const points = cellToBoundary(cell);
  const lats = points.map((p) => p[0]);
  const lngs = points.map((p) => p[1]);
  const [south, north] = [Math.min(...lats), Math.max(...lats)];
  const [west, east] = [Math.min(...lngs), Math.max(...lngs)];
  const margin = Math.max(north - south, east - west) * 0.25;
  return [south - margin, west - margin, north + margin, east + margin];
}

/**
 * Sutherland–Hodgman: a ring clipped to a box. A concave ring may come out with zero-width seams
 * along the box edge; they lie outside the cell the box is for, and only that cell is kept.
 * shortcut: rings across the antimeridian are not handled, needed only for Chukotka or Fiji.
 */
export function clipRing(ring: readonly LatLng[], [south, west, north, east]: Box): LatLng[] {
  const sides: [(p: LatLng) => boolean, (a: LatLng, b: LatLng) => LatLng][] = [
    [(p) => p[0] >= south, (a, b) => atLat(a, b, south)],
    [(p) => p[0] <= north, (a, b) => atLat(a, b, north)],
    [(p) => p[1] >= west, (a, b) => atLng(a, b, west)],
    [(p) => p[1] <= east, (a, b) => atLng(a, b, east)],
  ];
  let points: LatLng[] = [...ring];
  for (const [inside, cross] of sides) {
    const input = points;
    points = [];
    let previous = input.at(-1);
    for (const current of input) {
      if (previous && inside(current) !== inside(previous)) points.push(cross(previous, current));
      if (inside(current)) points.push(current);
      previous = current;
    }
    if (points.length === 0) break;
  }
  return points;
}

/** Shoelace, in degrees²: only its sign and zero matter here. */
function area(ring: readonly LatLng[]): number {
  let sum = 0;
  let previous = ring.at(-1);
  for (const point of ring) {
    if (previous) sum += previous[1] * point[0] - point[1] * previous[0];
    previous = point;
  }
  return sum / 2;
}

function atLat(a: LatLng, b: LatLng, lat: number): LatLng {
  return [lat, a[1] + ((b[1] - a[1]) * (lat - a[0])) / (b[0] - a[0])];
}

function atLng(a: LatLng, b: LatLng, lng: number): LatLng {
  return [a[0] + ((b[0] - a[0]) * (lng - a[1])) / (b[1] - a[1]), lng];
}

/**
 * Holes are subtracted as cells: no need to know which outer ring a hole belongs to.
 * `touching`: a cell counts if any part of it is inside (water, closed ground: a spirit must not
 * stand even partly there, and a narrow canal may hold no cell centre at all). Otherwise the
 * cell's centre decides, which keeps the shares of parks and historic areas fair.
 * `tiny: false` for rings clipped to one cell, where an empty result means "not here".
 */
export function areaCells(
  outers: readonly LatLng[][],
  inners: readonly LatLng[][],
  { touching = false, tiny = true }: { touching?: boolean; tiny?: boolean } = {},
): Set<string> {
  const cells = new Set<string>();
  for (const ring of outers) {
    if (ring.length < 3) continue;
    const inside = touching
      ? polygonToCellsExperimental(ring, MEASURE_RES, POLYGON_TO_CELLS_FLAGS.containmentOverlapping)
      : polygonToCells(ring, MEASURE_RES);
    // Smaller than one measure cell (a chapel): no cell centre falls inside, still count it.
    if (inside.length === 0 && tiny) cells.add(centreCell(ring));
    for (const cell of inside) cells.add(cell);
  }
  for (const ring of inners) {
    if (ring.length < 3) continue;
    // An island only frees the cells wholly on it when the water blocks every touched cell.
    const hole = touching
      ? polygonToCellsExperimental(ring, MEASURE_RES, POLYGON_TO_CELLS_FLAGS.containmentFull)
      : polygonToCells(ring, MEASURE_RES);
    for (const cell of hole) cells.delete(cell);
  }
  return cells;
}

function widen(cells: Set<string>, rings = 1): Set<string> {
  const wide = new Set<string>();
  for (const cell of cells) for (const near of gridDisk(cell, rings)) wide.add(near);
  return wide;
}

/** Measure cells whose centre lies within `metres` of the line. */
export function bandCells(points: readonly LatLng[], metres: number): Set<string> {
  const band = new Set<string>();
  points.forEach((a, i) => {
    const b = points[i + 1] ?? a;
    if (i > 0 && b === a) return;
    for (const cell of widen(lineCells([a, b]), BAND_RINGS)) {
      if (!band.has(cell) && distanceToSegment(cellToLatLng(cell), a, b) <= metres) band.add(cell);
    }
  });
  return band;
}

/** Flat-earth metres: segments are a few hundred metres at most. */
function distanceToSegment(p: LatLng, a: LatLng, b: LatLng): number {
  const kx = METRES_PER_DEGREE * Math.cos((p[0] * Math.PI) / 180);
  const [px, py] = [(p[1] - a[1]) * kx, (p[0] - a[0]) * METRES_PER_DEGREE];
  const [bx, by] = [(b[1] - a[1]) * kx, (b[0] - a[0]) * METRES_PER_DEGREE];
  const length = bx * bx + by * by;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, (px * bx + py * by) / length));
  return Math.hypot(px - t * bx, py - t * by);
}

export function lineCells(points: readonly LatLng[]): Set<string> {
  const cells = new Set<string>();
  let previous: string | undefined;
  for (const [lat, lng] of points) {
    const cell = latLngToCell(lat, lng, MEASURE_RES);
    if (previous && previous !== cell) {
      for (const step of pathBetween(previous, cell)) cells.add(step);
    }
    cells.add(cell);
    previous = cell;
  }
  return cells;
}

/** Straight grid path; H3 cannot draw it across a pentagon, then the ends are enough. */
function pathBetween(from: string, to: string): string[] {
  try {
    return gridPathCells(from, to);
  } catch {
    return [from, to];
  }
}

function centreCell(ring: readonly LatLng[]): string {
  let lat = 0;
  let lng = 0;
  for (const [a, b] of ring) {
    lat += a;
    lng += b;
  }
  return latLngToCell(lat / ring.length, lng / ring.length, MEASURE_RES);
}
