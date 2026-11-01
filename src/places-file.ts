import { createReadStream, createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';

import { SPAWN_CELL_RES } from './shared';
import { getResolution, isValidCell } from 'h3-js';

import { decodePlace, encodePlace, type PlaceInfo } from './place';

/**
 * Place types computed away from the server (roadmap 33): the heavy OSM pass runs on any machine,
 * the server only loads its result. Gzipped text: a JSON header line, then `cell<TAB>value` per
 * cell, the value being what the hot path keeps in `place:{cell}`.
 */
const FORMAT = 'urban-spirits/places';
const VERSION = 1;
const LINES_PER_CHUNK = 1_000;
const REGION = /^[a-z0-9_-]+$/;
const REGION_RULE = 'the region is lowercase latin letters, digits, - and _';

export interface PlacesFile {
  region: string;
  sourceDate: Date | undefined;
  places: Map<string, PlaceInfo>;
}

interface Header {
  format: string;
  version: number;
  region: string;
  sourceDate: string | null;
  cells: number;
}

export async function writePlacesFile(
  path: string,
  { region, sourceDate, places }: PlacesFile,
): Promise<void> {
  assertRegion(region);
  const header: Header = {
    format: FORMAT,
    version: VERSION,
    region,
    sourceDate: sourceDate?.toISOString() ?? null,
    cells: places.size,
  };
  await pipeline(Readable.from(chunks(header, places)), createGzip(), createWriteStream(path));
}

/** Lines in chunks: millions of one-line writes would cost more than the gzip itself. */
function* chunks(header: Header, places: ReadonlyMap<string, PlaceInfo>): Generator<string> {
  let lines = [JSON.stringify(header)];
  for (const [cell, info] of places) {
    lines.push(`${cell}\t${encodePlace(info)}`);
    if (lines.length === LINES_PER_CHUNK) {
      yield `${lines.join('\n')}\n`;
      lines = [];
    }
  }
  if (lines.length > 0) yield `${lines.join('\n')}\n`;
}

/** Throws on anything off: a file from another machine must not put wrong ground on the map. */
export async function readPlacesFile(path: string): Promise<PlacesFile> {
  const input = createInterface({
    input: createReadStream(path).pipe(createGunzip()),
    crlfDelay: Infinity,
  });
  let header: Header | undefined;
  const places = new Map<string, PlaceInfo>();
  let lineNo = 0;
  for await (const line of input) {
    lineNo += 1;
    if (!header) {
      header = parseHeader(line);
      continue;
    }
    if (line === '') continue;
    const [cell = '', value = '', extra] = line.split('\t');
    const info = decodePlace(value);
    // Decoding falls back to `urban` and "no mask" on bad input; only a round trip shows it.
    if (extra !== undefined || !isSpawnCell(cell) || encodePlace(info) !== value) {
      throw new Error(`places file, line ${String(lineNo)}: not "cell<TAB>place[|mask]"`);
    }
    places.set(cell, info);
  }
  if (!header) throw new Error('places file is empty');
  if (places.size !== header.cells) {
    throw new Error(
      `places file holds ${String(places.size)} cells, its header says ${String(header.cells)}: cut short?`,
    );
  }
  return {
    region: header.region,
    sourceDate: header.sourceDate === null ? undefined : new Date(header.sourceDate),
    places,
  };
}

function parseHeader(line: string): Header {
  let header: Partial<Header>;
  try {
    header = JSON.parse(line) as Partial<Header>;
  } catch {
    throw new Error('not a places file: the first line is not JSON');
  }
  if (header.format !== FORMAT || header.version !== VERSION) {
    throw new Error(`not a ${FORMAT} v${String(VERSION)} file`);
  }
  if (typeof header.region !== 'string' || !REGION.test(header.region)) {
    throw new Error(`places file: ${REGION_RULE}`);
  }
  if (typeof header.cells !== 'number' || !Number.isInteger(header.cells) || header.cells < 0) {
    throw new Error('places file: bad cell count');
  }
  const date = header.sourceDate;
  if (date !== null && (typeof date !== 'string' || Number.isNaN(Date.parse(date)))) {
    throw new Error('places file: bad source date');
  }
  return header as Header;
}

/** The CLI checks it before a long OSM pass, not after. */
export function assertRegion(region: string): void {
  if (!REGION.test(region)) throw new Error(REGION_RULE);
}

function isSpawnCell(cell: string): boolean {
  return isValidCell(cell) && getResolution(cell) === SPAWN_CELL_RES;
}
