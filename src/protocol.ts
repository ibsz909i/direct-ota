/** Shared wire contract. No Deno, Node, Storage or application dependencies. */
export const OTA_BUCKET = "direct-ota";
export interface OtaTrust {
  appId: string;
  environment: string;
  artifactBaseUrl: string;
  keyId: string;
  publicJwk: JsonWebKey;
  /** Native-pinned keys in ascending trust epoch; active publisher is keyId. */
  trustedKeys?: Array<{keyId: string; publicJwk: JsonWebKey}>;
  backendContract: number;
  limits?: OtaLimits;
}
export interface OtaLimits { archiveBytes: number; unpackedBytes: number; files: number }
export const OTA_DEFAULT_LIMITS: Readonly<OtaLimits> = Object.freeze({archiveBytes: 5 * 1024 * 1024, unpackedBytes: 25 * 1024 * 1024, files: 1000});
export const OTA_ABSOLUTE_LIMITS: Readonly<OtaLimits> = Object.freeze({archiveBytes: 50 * 1024 * 1024, unpackedBytes: 100 * 1024 * 1024, files: 5000});
export function effectiveLimits(trust: OtaTrust): OtaLimits {
  const limits = trust.limits ?? OTA_DEFAULT_LIMITS;
  if (!limits || typeof limits !== 'object' || Array.isArray(limits)) throw new Error('Invalid OTA limits');
  exactKeys(limits as unknown as Record<string,unknown>, ['archiveBytes','unpackedBytes','files']);
  for (const field of ['archiveBytes','unpackedBytes','files'] as const) {
    if (!Number.isSafeInteger(limits[field]) || limits[field] < OTA_DEFAULT_LIMITS[field] || limits[field] > OTA_ABSOLUTE_LIMITS[field]) throw new Error('Invalid OTA limits');
  }
  if (limits.unpackedBytes < limits.archiveBytes) throw new Error('Invalid OTA limits');
  return limits;
}
export function validateTrust(trust: OtaTrust): OtaTrust {
  effectiveLimits(trust);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(trust.appId) ||
      !/^[A-Za-z0-9_-]{1,40}$/.test(trust.environment) ||
      !Number.isSafeInteger(trust.backendContract) || trust.backendContract < 1 ||
      !/^[A-Za-z0-9_-]{1,80}$/.test(trust.keyId) ||
      !validSigningJwk(trust.publicJwk)) throw new Error('Invalid OTA trust configuration');
  if (trust.trustedKeys !== undefined) {
    if (!Array.isArray(trust.trustedKeys) || trust.trustedKeys.length < 2 || trust.trustedKeys.length > 4) throw new Error('Invalid OTA signing key ring');
    const seen = new Set<string>();
    for (const entry of trust.trustedKeys) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
          Object.keys(entry).sort().join(',') !== 'keyId,publicJwk' ||
          typeof entry.keyId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(entry.keyId) ||
          seen.has(entry.keyId) || !validSigningJwk(entry.publicJwk)) throw new Error('Invalid OTA signing key ring');
      seen.add(entry.keyId);
    }
    const active = trust.trustedKeys.find(entry => entry.keyId === trust.keyId);
    if (!active || active.publicJwk.x !== trust.publicJwk.x || active.publicJwk.y !== trust.publicJwk.y)
      throw new Error('Active publisher is not pinned in the key ring');
  }
  const u = new URL(trust.artifactBaseUrl);
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash ||
      u.href !== trust.artifactBaseUrl || trust.artifactBaseUrl.endsWith('/') ||
      !/^\/[A-Za-z0-9/_-]*$/.test(u.pathname)) throw new Error('Artifact base must be a canonical HTTPS URL without a trailing slash');
  return trust;
}
function validSigningJwk(key: JsonWebKey | undefined): boolean {
  const kid = (key as JsonWebKey & {kid?: unknown} | undefined)?.kid;
  if (!key || typeof key !== 'object' || Array.isArray(key) ||
      key.kty !== 'EC' || key.crv !== 'P-256' ||
      Object.keys(key).some(field => !['kty','crv','x','y','alg','use','key_ops','kid','ext'].includes(field)) ||
      (key.alg !== undefined && key.alg !== 'ES256') ||
      (key.use !== undefined && key.use !== 'sig') ||
      (key.key_ops !== undefined && (!Array.isArray(key.key_ops) || key.key_ops.length !== 1 || key.key_ops[0] !== 'verify')) ||
      (key.ext !== undefined && typeof key.ext !== 'boolean') ||
      (kid !== undefined && (typeof kid !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(kid)))) return false;
  for (const coordinate of [key.x,key.y]) {
    if (typeof coordinate !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(coordinate)) return false;
    try { if (decodeSegment(coordinate).length !== 32) return false; } catch { return false; }
  }
  return true;
}
export const OTA_MAX_MANIFEST_LENGTH = 8192;
export const OTA_MAX_ARCHIVE_BYTES = OTA_DEFAULT_LIMITS.archiveBytes;
export const OTA_MAX_UNPACKED_BYTES = OTA_DEFAULT_LIMITS.unpackedBytes;
export const OTA_MAX_FILES = OTA_DEFAULT_LIMITS.files;
export const OTA_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const OTA_HASH = /^[0-9a-f]{64}$/;
export type OtaPlatform = "ios" | "android";
export type OtaChannel = "internal" | "production";
export interface OtaSelector {
  platform: OtaPlatform;
  channel: OtaChannel;
  runtime: string;
}
export interface OtaHistoryRequest extends OtaSelector { limit: number; beforeSequence?: number }
export interface OtaHistoryItem { releaseId: string; sequence: number; version: string; action: 'release'|'withdraw'; mode: 'required'|'background'|null; rollout: number; issuedAt: string; artifact: {id: string; sha256: string; bytes: number}|null }
export function historyItem(manifest: OtaManifest): OtaHistoryItem {
  const artifact=manifest.action==='release'?manifest.artifact:null;
  return {releaseId:manifest.releaseId,sequence:manifest.sequence,version:manifest.version,action:manifest.action,
    mode:manifest.action==='release'?manifest.mode??'required':null,
    rollout:manifest.rollout,issuedAt:manifest.issuedAt,
    artifact:artifact?{id:artifact.path.split('/')[2],sha256:artifact.sha256,bytes:artifact.bytes}:null};
}
export function validateHistoryRequest(value: unknown): OtaHistoryRequest {
  const v = object(value);
  exactKeys(v, v.beforeSequence === undefined ? ['platform','channel','runtime','limit'] : ['platform','channel','runtime','limit','beforeSequence']);
  validateSelector({platform:v.platform,channel:v.channel,runtime:v.runtime});
  if (!integer(v.limit,1,50) || (v.beforeSequence !== undefined && !integer(v.beforeSequence,1,Number.MAX_SAFE_INTEGER))) invalid();
  return v as unknown as OtaHistoryRequest;
}
export interface OtaArtifact {
  path: string;
  url: string;
  sha256: string;
  bytes: number;
  unpackedBytes: number;
  files: number;
  checksum: string;
  sessionKey: string;
  /** Signed encrypted patch appended to the same immutable Storage object. */
  delta?: {
    fromSha256: string;
    baseChecksum: string;
    fullBytes: number;
    fullSha256: string;
    offset: number;
    bytes: number;
    sha256: string;
    checksum: string;
    sessionKey: string;
  };
}
interface OtaBase extends OtaSelector {
  protocol: 1;
  appId: string;
  environment: string;
  sequence: number;
  backendContract: number;
  rollout: number;
  releaseId: string;
  version: string;
  issuedAt: string;
  mode?: "required" | "background";
}
export type OtaManifest =
  & OtaBase
  & ({ action: "release"; artifact: OtaArtifact } | { action: "withdraw" });
export interface OtaCompatibility {
  platform?: string;
  channel?: string;
  runtime?: string;
  backendContract?: number;
}
export interface OtaPublishCommand {
  protocol: 1;
  appId: string;
  aud: "direct-ota-publish";
  action: "reserve" | "promote" | "status" | "health" | "history" | "inspect";
  iat: number;
  exp: number;
  nonce: string;
  body: Record<string, unknown>;
}
function invalid(): never {
  throw new Error("Invalid OTA protocol");
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
export function exactKeys(
  value: Record<string, unknown>,
  expected: string[],
): void {
  const actual = Object.keys(value);
  if (
    actual.length !== expected.length ||
    actual.some((key) => !expected.includes(key))
  ) invalid();
}
function integer(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= min &&
    (value as number) <= max;
}
export function validateSelector(value: unknown): OtaSelector {
  const v = object(value);
  exactKeys(v, ["platform", "channel", "runtime"]);
  if (
    (v.platform !== "ios" && v.platform !== "android") ||
    (v.channel !== "internal" && v.channel !== "production") ||
    typeof v.runtime !== "string" || !OTA_HASH.test(v.runtime)
  ) invalid();
  return v as unknown as OtaSelector;
}
function base64(value: unknown, lengths: number[]): boolean {
  if (
    typeof value !== "string" || value.length > 700 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) return false;
  try {
    const decoded = atob(value);
    return lengths.includes(decoded.length) && btoa(decoded) === value;
  } catch {
    return false;
  }
}
export function validateManifest(
  value: unknown,
  trust: OtaTrust,
  compatibility: OtaCompatibility = {},
  now = Date.now(),
): OtaManifest {
  validateTrust(trust);
  const v = object(value);
  const fields = [
    "protocol",
    "appId",
    "environment",
    "platform",
    "channel",
    "sequence",
    "runtime",
    "backendContract",
    "action",
    "rollout",
    "releaseId",
    "version",
    "issuedAt",
  ];
  exactKeys(v, v.action === "release" ? [...fields, "artifact", ...(v.mode === undefined ? [] : ["mode"])] : fields);
  validateSelector({
    platform: v.platform,
    channel: v.channel,
    runtime: v.runtime,
  });
  if (
    v.protocol !== 1 || v.appId !== trust.appId ||
    v.environment !== trust.environment || v.backendContract !== trust.backendContract ||
    (v.action !== "release" && v.action !== "withdraw") ||
    !integer(v.sequence, 1, Number.MAX_SAFE_INTEGER) ||
    !integer(v.rollout, 0, 100) || typeof v.releaseId !== "string" ||
    !OTA_UUID.test(v.releaseId)
  ) invalid();
  // SemVer 2.0, bounded to prevent large metadata and inconsistent native parsing.
  if (
    typeof v.version !== "string" || v.version.length > 64 ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
      .test(v.version)
  ) invalid();
  if (
    typeof v.issuedAt !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(v.issuedAt)
  ) invalid();
  const issued = Date.parse(v.issuedAt);
  if (
    !Number.isFinite(issued) || issued > now + 300_000 ||
    new Date(issued).toISOString().replace(".000Z", "Z") !==
      v.issuedAt.replace(".000Z", "Z")
  ) invalid();
  for (
    const field of [
      "platform",
      "channel",
      "runtime",
      "backendContract",
    ] as const
  ) {
    if (
      compatibility[field] !== undefined && compatibility[field] !== v[field]
    ) invalid();
  }
  if (v.action === "release") {
    if (v.mode !== undefined && v.mode !== "required" && v.mode !== "background") invalid();
    const a = object(v.artifact);
    exactKeys(a, [
      "path",
      "url",
      "sha256",
      "bytes",
      "unpackedBytes",
      "files",
      "checksum",
      "sessionKey",
      ...(a.delta === undefined ? [] : ["delta"]),
    ]);
    if (
      typeof a.sha256 !== "string" || !OTA_HASH.test(a.sha256) ||
      !integer(a.bytes, 1, effectiveLimits(trust).archiveBytes) ||
      !integer(a.unpackedBytes, 1, effectiveLimits(trust).unpackedBytes) ||
      !integer(a.files, 1, effectiveLimits(trust).files)
    ) invalid();
    if (typeof a.path !== "string" || a.path.length > 220) invalid();
    const parts = a.path.split("/");
    // A rollback has a new manifest ID but retains the original immutable artifact ID.
    if (
      parts.length !== 4 || parts[0] !== v.platform || parts[1] !== v.runtime ||
      !OTA_UUID.test(parts[2]) || parts[3] !== `${a.sha256}.zip`
    ) invalid();
    if (
      a.url !== `${trust.artifactBaseUrl}/${a.path}`
    ) invalid();
    validateEnvelope(a.checksum,a.sessionKey);
    if (a.delta !== undefined) {
      const d=object(a.delta);
      exactKeys(d,['fromSha256','baseChecksum','fullBytes','fullSha256','offset','bytes','sha256','checksum','sessionKey']);
      if (typeof d.fromSha256 !== 'string' || !OTA_HASH.test(d.fromSha256) ||
          typeof d.baseChecksum !== 'string' || !OTA_HASH.test(d.baseChecksum) ||
          typeof d.fullSha256 !== 'string' || !OTA_HASH.test(d.fullSha256) ||
          typeof d.sha256 !== 'string' || !OTA_HASH.test(d.sha256) ||
          d.fromSha256 === a.sha256 ||
          !integer(d.fullBytes,1,effectiveLimits(trust).archiveBytes) ||
          !integer(d.bytes,1,effectiveLimits(trust).archiveBytes) ||
          d.offset !== d.fullBytes || d.fullBytes+d.bytes !== a.bytes ||
          d.bytes >= d.fullBytes || d.bytes > 5*1024*1024) invalid();
      validateEnvelope(d.checksum,d.sessionKey);
    }
  }
  return v as unknown as OtaManifest;
}
function validateEnvelope(checksum: unknown, sessionKey: unknown): void {
  if (!(base64(checksum,[256]) ||
      typeof checksum === 'string' && /^[0-9a-f]{512}$/.test(checksum)) ||
      typeof sessionKey !== 'string') invalid();
  const parts=sessionKey.split(':');
  if (parts.length !== 2 || !base64(parts[0],[16]) || !base64(parts[1],[256])) invalid();
}
function decodeSegment(segment: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) invalid();
  const normalized = segment.replace(/-/g, "+").replace(/_/g, "/");
  let decoded: string;
  try {
    decoded = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  } catch {
    invalid();
  }
  if (
    btoa(decoded).replace(/=+$/g, "").replace(/\+/g, "-").replace(
      /\//g,
      "_",
    ) !== segment
  ) invalid();
  return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
}
async function verifyJws(
  compact: string,
  publicKey: JsonWebKey,
  keyId: string,
  typ: string,
  limit: number,
): Promise<unknown> {
  if (
    typeof compact !== "string" || compact.length > limit ||
    !/^[A-Za-z0-9._-]+$/.test(compact)
  ) invalid();
  if (
    !/^[A-Za-z0-9_-]{1,80}$/.test(keyId) || publicKey.kty !== "EC" ||
    publicKey.crv !== "P-256" || publicKey.d !== undefined ||
    (publicKey.alg !== undefined && publicKey.alg !== "ES256")
  ) invalid();
  const parts = compact.split(".");
  if (parts.length !== 3) invalid();
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  const header = object(JSON.parse(text.decode(decodeSegment(parts[0]))));
  exactKeys(header, ["alg", "typ", "kid"]);
  if (header.alg !== "ES256" || header.typ !== typ || header.kid !== keyId) {
    invalid();
  }
  const signature = decodeSegment(parts[2]);
  if (signature.length !== 64) invalid();
  const key = await crypto.subtle.importKey(
    "jwk",
    publicKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  if (
    !await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      signature,
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    )
  ) invalid();
  return JSON.parse(text.decode(decodeSegment(parts[1])));
}
export async function verifyManifest(
  compact: string,
  trust: OtaTrust,
  compatibility: OtaCompatibility = {},
  now = Date.now(),
): Promise<OtaManifest> {
  validateTrust(trust);
  const keyId = signedKeyId(compact, OTA_MAX_MANIFEST_LENGTH);
  const selected = trust.trustedKeys?.find(entry => entry.keyId === keyId) ??
    (keyId === trust.keyId ? {keyId: trust.keyId, publicJwk: trust.publicJwk} : undefined);
  if (!selected) invalid();
  return validateManifest(
    await verifyJws(
      compact,
      selected.publicJwk,
      selected.keyId,
      "DIRECT-OTA",
      OTA_MAX_MANIFEST_LENGTH,
    ),
    trust,
    compatibility,
    now,
  );
}
/** Extract an untrusted key ID only to select a pinned verification key. */
export function signedKeyId(compact: string, limit = OTA_MAX_MANIFEST_LENGTH): string {
  if (typeof compact !== 'string' || compact.length > limit || !/^[A-Za-z0-9._-]+$/.test(compact)) invalid();
  const parts = compact.split('.');
  if (parts.length !== 3) invalid();
  const header = object(JSON.parse(new TextDecoder('utf-8', {fatal:true,ignoreBOM:false}).decode(decodeSegment(parts[0]))));
  exactKeys(header, ['alg','typ','kid']);
  if (header.alg !== 'ES256' || header.typ !== 'DIRECT-OTA' ||
      typeof header.kid !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(header.kid)) invalid();
  return header.kid;
}
export async function verifyPublishCommand(
  compact: string,
  trust: OtaTrust,
  now = Date.now(),
): Promise<OtaPublishCommand> {
  validateTrust(trust);
  const v = object(
    await verifyJws(compact, trust.publicJwk, trust.keyId, "DIRECT-OTA-PUBLISH", 16_384),
  );
  exactKeys(v, [
    "protocol",
    "appId",
    "aud",
    "action",
    "iat",
    "exp",
    "nonce",
    "body",
  ]);
  const seconds = Math.floor(now / 1000);
  if (
    v.protocol !== 1 || v.appId !== trust.appId ||
    v.aud !== "direct-ota-publish" ||
    !["reserve", "promote", "status", "health", "history", "inspect"].includes(v.action as string) ||
    !integer(v.iat, seconds - 60, seconds + 5) ||
    !integer(v.exp, seconds + 1, seconds + 65) ||
    (v.exp as number) <= (v.iat as number) ||
    (v.exp as number) - (v.iat as number) > 60 || typeof v.nonce !== "string" ||
    !OTA_UUID.test(v.nonce)
  ) invalid();
  object(v.body);
  return v as unknown as OtaPublishCommand;
}
