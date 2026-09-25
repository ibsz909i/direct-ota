/** Shared wire contract. No Deno, Node, Storage or application dependencies. */
export const OTA_BUCKET = "direct-ota";
export interface OtaTrust {
  appId: string;
  environment: string;
  artifactBaseUrl: string;
  keyId: string;
  publicJwk: JsonWebKey;
  backendContract: number;
}
export function validateTrust(trust: OtaTrust): OtaTrust {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(trust.appId) ||
      !/^[A-Za-z0-9_-]{1,40}$/.test(trust.environment) ||
      !Number.isSafeInteger(trust.backendContract) || trust.backendContract < 1 ||
      !/^[A-Za-z0-9_-]{1,80}$/.test(trust.keyId) ||
      trust.publicJwk.kty !== 'EC' || trust.publicJwk.crv !== 'P-256' || trust.publicJwk.d !== undefined) throw new Error('Invalid OTA trust configuration');
  const u = new URL(trust.artifactBaseUrl);
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash ||
      u.href !== trust.artifactBaseUrl || trust.artifactBaseUrl.endsWith('/') ||
      !/^\/[A-Za-z0-9/_-]*$/.test(u.pathname)) throw new Error('Artifact base must be a canonical HTTPS URL without a trailing slash');
  return trust;
}
export const OTA_MAX_MANIFEST_LENGTH = 8192;
export const OTA_MAX_ARCHIVE_BYTES = 5 * 1024 * 1024;
export const OTA_MAX_UNPACKED_BYTES = 25 * 1024 * 1024;
export const OTA_MAX_FILES = 1000;
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
export interface OtaArtifact {
  path: string;
  url: string;
  sha256: string;
  bytes: number;
  unpackedBytes: number;
  files: number;
  checksum: string;
  sessionKey: string;
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
  action: "reserve" | "promote" | "status";
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
  exactKeys(v, v.action === "release" ? [...fields, "artifact"] : fields);
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
    ]);
    if (
      typeof a.sha256 !== "string" || !OTA_HASH.test(a.sha256) ||
      !integer(a.bytes, 1, OTA_MAX_ARCHIVE_BYTES) ||
      !integer(a.unpackedBytes, 1, OTA_MAX_UNPACKED_BYTES) ||
      !integer(a.files, 1, OTA_MAX_FILES)
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
    if (
      !(base64(a.checksum, [256]) ||
        typeof a.checksum === "string" && /^[0-9a-f]{512}$/.test(a.checksum)) ||
      typeof a.sessionKey !== "string"
    ) invalid();
    const envelope = a.sessionKey.split(":");
    if (
      envelope.length !== 2 || !base64(envelope[0], [16]) ||
      !base64(envelope[1], [256])
    ) invalid();
  }
  return v as unknown as OtaManifest;
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
  return validateManifest(
    await verifyJws(
      compact,
      trust.publicJwk,
      trust.keyId,
      "DIRECT-OTA",
      OTA_MAX_MANIFEST_LENGTH,
    ),
    trust,
    compatibility,
    now,
  );
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
    !["reserve", "promote", "status"].includes(v.action as string) ||
    !integer(v.iat, seconds - 60, seconds + 5) ||
    !integer(v.exp, seconds + 1, seconds + 65) ||
    (v.exp as number) <= (v.iat as number) ||
    (v.exp as number) - (v.iat as number) > 60 || typeof v.nonce !== "string" ||
    !OTA_UUID.test(v.nonce)
  ) invalid();
  object(v.body);
  return v as unknown as OtaPublishCommand;
}
