import { availableParallelism } from 'node:os';
import { parseArgs } from 'node:util';

import { computePlaces } from './import';
import { writePlacesFile } from './places-file';
import { fileSource } from './read';

const USAGE = 'usage: osm-places <extract.osm.pbf> --region <name> --out <file.places.gz> [--threads <n>]';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { region: { type: 'string' }, out: { type: 'string' }, threads: { type: 'string' } },
});
const [file] = positionals;
const region = values.region?.trim().toLowerCase();
if (!file || !region || !values.out) throw new Error(USAGE);
const threads = Number(values.threads ?? Math.max(1, availableParallelism() - 2));
if (!Number.isInteger(threads) || threads < 1) throw new Error(USAGE);

const { sourceDate, places, features } = await computePlaces(fileSource(file), { threads });
await writePlacesFile(values.out, { region, sourceDate, places });
console.log(`${region}: ${String(features)} features → ${String(places.size)} cells → ${values.out}`);
