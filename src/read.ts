import { createReadStream } from 'node:fs';

import { readOsmPbf, type OsmPbfBlock, type OsmPbfHeaderBlock } from '@osmix/pbf';

import type { Feature, LatLng } from './cells';
import {
  areaKind,
  closedWayIsArea,
  isMultipolygon,
  lineKind,
  pointKind,
  type AreaKind,
  type LineKind,
  type Tags,
} from './tags';

/** Opens the data again for each pass: blocks are streamed, never held all at once. */
export type PbfSource = () => AsyncIterable<Uint8Array> | Uint8Array;

export function fileSource(path: string): PbfSource {
  return () => createReadStream(path);
}

export interface OsmExtract {
  /** Replication timestamp of the extract (Geofabrik sets it), if present. */
  sourceDate: Date | undefined;
  features: Feature[];
}

interface Multipolygon {
  kind: AreaKind;
  outer: number[];
  inner: number[];
}

const RELATION_MEMBER_WAY = 1;
const DEFAULT_GRANULARITY = 100;

/**
 * Three passes, because a PBF lists nodes, then ways, then relations, while geometry needs them
 * the other way round: relations name the ways they need, ways name the nodes.
 */
export async function readOsmExtract(source: PbfSource): Promise<OsmExtract> {
  // Pass 1: multipolygon relations with a meaning, and the ways they are made of.
  const multipolygons: Multipolygon[] = [];
  const header = await eachBlock(source, (block, strings) => {
    for (const group of block.primitivegroup) {
      for (const relation of group.relations) {
        const tags = tagsOf(relation.keys, relation.vals, strings);
        const kind = isMultipolygon(tags) ? areaKind(tags) : undefined;
        if (!kind) continue;
        const polygon: Multipolygon = { kind, outer: [], inner: [] };
        let id = 0;
        relation.memids.forEach((delta, i) => {
          id += delta;
          if (relation.types[i] !== RELATION_MEMBER_WAY) return;
          const role = strings(relation.roles_sid[i] ?? 0);
          (role === 'inner' ? polygon.inner : polygon.outer).push(id);
        });
        multipolygons.push(polygon);
      }
    }
  });
  const memberWays = new Set(multipolygons.flatMap((p) => [...p.outer, ...p.inner]));

  // Pass 2: ways that are features themselves or parts of a multipolygon.
  const wayRefs = new Map<number, number[]>();
  const areaWays: { kind: AreaKind; id: number }[] = [];
  const lineWays: { kind: LineKind; id: number }[] = [];
  await eachBlock(source, (block, strings) => {
    for (const group of block.primitivegroup) {
      for (const way of group.ways) {
        const tags = tagsOf(way.keys, way.vals, strings);
        const refs = deltaDecode(way.refs);
        const closed = refs.length >= 4 && refs[0] === refs.at(-1);
        const area = closed && closedWayIsArea(tags) ? areaKind(tags) : undefined;
        const line = area ? undefined : lineKind(tags);
        if (area) areaWays.push({ kind: area, id: way.id });
        if (line) lineWays.push({ kind: line, id: way.id });
        if (area || line || memberWays.has(way.id)) wayRefs.set(way.id, refs);
      }
    }
  });

  // Pass 3: coordinates of the nodes those ways use, and meaningful single nodes.
  const nodes = new NodeIndex(wayRefs.values());
  const features: Feature[] = [];
  await eachBlock(source, (block, strings) => {
    const granularity = block.granularity ?? DEFAULT_GRANULARITY;
    const latOffset = block.lat_offset ?? 0;
    const lonOffset = block.lon_offset ?? 0;
    const toDegrees = (raw: number, offset: number) => (offset + granularity * raw) * 1e-9;
    const visit = (id: number, rawLat: number, rawLon: number, tags: () => Tags) => {
      const lat = toDegrees(rawLat, latOffset);
      const lng = toDegrees(rawLon, lonOffset);
      nodes.set(id, lat, lng);
      const kind = pointKind(tags());
      if (kind) features.push({ type: 'point', kind, point: [lat, lng] });
    };

    for (const group of block.primitivegroup) {
      for (const node of group.nodes) {
        visit(node.id, node.lat, node.lon, () => tagsOf(node.keys, node.vals, strings));
      }
      const dense = group.dense;
      if (!dense) continue;
      let id = 0;
      let lat = 0;
      let lon = 0;
      let kv = 0;
      for (let i = 0; i < dense.id.length; i++) {
        id += dense.id[i] ?? 0;
        lat += dense.lat[i] ?? 0;
        lon += dense.lon[i] ?? 0;
        // keys_vals: k,v,k,v,…,0 per node; empty when no node in the block has tags.
        const start = kv;
        while (kv < dense.keys_vals.length && dense.keys_vals[kv] !== 0) kv += 2;
        const end = kv;
        if (dense.keys_vals.length > 0) kv += 1;
        visit(id, lat, lon, () => denseTags(dense.keys_vals, start, end, strings));
      }
    }
  });

  const coords = (refs: readonly number[]) => refs.flatMap((ref) => nodes.get(ref) ?? []);
  for (const { kind, id } of areaWays) {
    features.push({ type: 'area', kind, outers: [coords(wayRefs.get(id) ?? [])], inners: [] });
  }
  for (const { kind, id } of lineWays) {
    features.push({ type: 'line', kind, points: coords(wayRefs.get(id) ?? []) });
  }
  for (const { kind, outer, inner } of multipolygons) {
    // Each member way is one piece; missing ones were cut off by the extract border.
    const pieces = (ids: number[]) =>
      ids.flatMap((id) => {
        const refs = wayRefs.get(id);
        return refs ? [refs] : [];
      });
    const rings = (ids: number[]) => assembleRings(pieces(ids)).map(coords);
    features.push({ type: 'area', kind, outers: rings(outer), inners: rings(inner) });
  }

  const timestamp = header.osmosis_replication_timestamp;
  return { sourceDate: timestamp ? new Date(timestamp * 1000) : undefined, features };
}

/**
 * Joins way pieces end to end into rings. Pieces may be reversed; a ring that cannot be
 * closed (the extract cut it at its border) is kept as it is: good enough for shares.
 */
export function assembleRings(pieces: readonly (readonly number[])[]): number[][] {
  const unused = pieces.filter((p) => p.length >= 2).map((p) => [...p]);
  const rings: number[][] = [];
  while (unused.length > 0) {
    const ring = unused.shift() ?? [];
    let extended = true;
    while (extended && ring[0] !== ring.at(-1)) {
      extended = false;
      const last = ring.at(-1);
      const next = unused.findIndex((p) => p[0] === last || p.at(-1) === last);
      if (next >= 0) {
        const [piece = []] = unused.splice(next, 1);
        if (piece[0] !== last) piece.reverse();
        ring.push(...piece.slice(1));
        extended = true;
      }
    }
    if (ring.length >= 3) rings.push(ring);
  }
  return rings;
}

async function eachBlock(
  source: PbfSource,
  visit: (block: OsmPbfBlock, strings: (index: number) => string) => void,
): Promise<OsmPbfHeaderBlock> {
  const { header, blocks } = await readOsmPbf(source());
  const decoder = new TextDecoder();
  for await (const block of blocks) {
    const cache: (string | undefined)[] = [];
    visit(block, (index) => {
      let value = cache[index];
      if (value === undefined) {
        value = decoder.decode(block.stringtable[index]);
        cache[index] = value;
      }
      return value;
    });
  }
  return header;
}

function tagsOf(keys: number[], vals: number[], strings: (i: number) => string): Tags {
  const tags = new Map<string, string>();
  keys.forEach((key, i) => tags.set(strings(key), strings(vals[i] ?? 0)));
  return tags;
}

function denseTags(keysVals: number[], start: number, end: number, strings: (i: number) => string) {
  const tags = new Map<string, string>();
  for (let i = start; i < end; i += 2)
    tags.set(strings(keysVals[i] ?? 0), strings(keysVals[i + 1] ?? 0));
  return tags;
}

function deltaDecode(deltas: readonly number[]): number[] {
  let value = 0;
  return deltas.map((delta) => (value += delta));
}

/**
 * Coordinates of the needed nodes only: sorted ids with binary search, ~24 bytes per node.
 * A city extract has millions of nodes, most of them irrelevant here.
 */
class NodeIndex {
  private readonly ids: Float64Array;
  private readonly lat: Float64Array;
  private readonly lng: Float64Array;

  constructor(refLists: Iterable<readonly number[]>) {
    const lists = [...refLists];
    const all = new Float64Array(lists.reduce((n, list) => n + list.length, 0));
    let at = 0;
    for (const list of lists) {
      all.set(list, at);
      at += list.length;
    }
    all.sort();
    // Duplicates dropped in place: a Set holds at most 2^24 ids, a country's paths need more
    // (Belarus with footways and tracks, 21.10).
    let size = 0;
    for (const id of all) if (size === 0 || all[size - 1] !== id) all[size++] = id;
    this.ids = all.subarray(0, size);
    this.lat = new Float64Array(size).fill(NaN);
    this.lng = new Float64Array(size).fill(NaN);
  }

  set(id: number, lat: number, lng: number): void {
    const i = this.find(id);
    if (i < 0) return;
    this.lat[i] = lat;
    this.lng[i] = lng;
  }

  get(id: number): [LatLng] | undefined {
    const i = this.find(id);
    const lat = this.lat[i];
    const lng = this.lng[i];
    if (i < 0 || lat === undefined || lng === undefined || Number.isNaN(lat)) return undefined;
    return [[lat, lng]];
  }

  private find(id: number): number {
    let lo = 0;
    let hi = this.ids.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const value = this.ids[mid] ?? 0;
      if (value === id) return mid;
      if (value < id) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }
}
