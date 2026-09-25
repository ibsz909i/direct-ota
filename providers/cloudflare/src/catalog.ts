import {verifyManifest, type OtaSelector, type OtaTrust} from './protocol.ts';
import {fail} from './security.ts';
import {selectorKey} from './state.ts';

const CATALOG_TTL_MS = 15000;
const FAILURE_COOLDOWN_MS = 5000;
const MAX_HEADS = 256;

type Catalog = {expires: number; manifests: Map<string, string>; verified: Set<string>};
let cached: Catalog | null = null;
let loading: Promise<Catalog> | null = null;
let retryAfter = 0;

async function refresh(db: D1Database, trust: OtaTrust): Promise<Catalog> {
  const rows = await db.prepare(`SELECT h.selector, r.signed FROM heads h
    JOIN releases r ON r.id = h.release_id LIMIT ?`).bind(MAX_HEADS + 1)
    .all<{selector: string; signed: string}>();
  if (rows.results.length > MAX_HEADS) fail(503, 'OTA_UNAVAILABLE');
  const manifests = new Map<string, string>();
  for (const row of rows.results) {
    manifests.set(row.selector, row.signed);
  }
  return {expires: Date.now() + CATALOG_TTL_MS, manifests, verified: new Set()};
}

/** Only public signed metadata is cached. No account or publisher state enters this cache. */
export async function catalogManifest(db: D1Database, trust: OtaTrust,
  selected: OtaSelector): Promise<string | null> {
  if (cached && cached.expires > Date.now()) return await selectedManifest(cached, trust, selected);
  if (retryAfter > Date.now()) fail(503, 'OTA_UNAVAILABLE');
  if (!loading) loading = refresh(db, trust).then(value => {
    cached = value;
    retryAfter = 0;
    return value;
  }, error => {
    retryAfter = Date.now() + FAILURE_COOLDOWN_MS;
    throw error;
  }).finally(() => { loading = null; });
  return await selectedManifest(await loading, trust, selected);
}

async function selectedManifest(catalog: Catalog, trust: OtaTrust,
  selected: OtaSelector): Promise<string | null> {
  const key = selectorKey(selected);
  const signed = catalog.manifests.get(key);
  if (!signed) return null;
  if (!catalog.verified.has(key)) {
    await verifyManifest(signed, trust, selected);
    catalog.verified.add(key);
  }
  return signed;
}

export function invalidateCatalog(): void { cached = null; retryAfter = 0; }
