import {createHash} from 'node:crypto';

// Binary patch for deterministic plaintext ZIPs. Never activate the output
// without checking the signed full-bundle checksum and ZIP safety limits.
const MAGIC = Buffer.from('DOTA-DLT1');
const HEADER_BYTES = MAGIC.length + 32 + 32 + 4 + 4;
const BLOCK_BYTES = 64;
const MAX_BYTES = 50 * 1024 * 1024;
const MAX_OPERATIONS = 100_000;
const sha256 = bytes => createHash('sha256').update(bytes).digest();
function bounded(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_BYTES) throw Error('Invalid delta input');
}

export function createDelta(source, target) {
  bounded(source); bounded(target);
  if (target.length === 0) throw Error('Empty delta target');
  // The bounded index keeps memory predictable for a maximum-size archive.
  const positions = new Map();
  for (let at = 0; at + BLOCK_BYTES <= source.length; at += BLOCK_BYTES) {
    const key = source.subarray(at, at + 16).toString('hex');
    if (!positions.has(key)) positions.set(key, at);
  }
  const operations = [];
  let at = 0, literalStart = 0;
  while (at + BLOCK_BYTES <= target.length) {
    const sourceAt = positions.get(target.subarray(at, at + 16).toString('hex'));
    if (sourceAt === undefined ||
        !source.subarray(sourceAt, sourceAt + BLOCK_BYTES).equals(target.subarray(at, at + BLOCK_BYTES))) {
      at++;
      continue;
    }
    if (at > literalStart) operations.push({kind:1, data:target.subarray(literalStart, at)});
    let length = BLOCK_BYTES;
    while (sourceAt + length < source.length && at + length < target.length &&
           source[sourceAt + length] === target[at + length]) length++;
    operations.push({kind:0, offset:sourceAt, length});
    at += length;
    literalStart = at;
    if (operations.length > MAX_OPERATIONS) throw Error('Delta operation limit exceeded');
  }
  if (literalStart < target.length) operations.push({kind:1, data:target.subarray(literalStart)});
  if (!operations.length || operations.length > MAX_OPERATIONS) throw Error('Invalid delta operations');
  const encoded = [MAGIC, sha256(source), sha256(target)];
  const header = Buffer.alloc(8);
  header.writeUInt32BE(target.length, 0);
  header.writeUInt32BE(operations.length, 4);
  encoded.push(header);
  for (const op of operations) {
    if (op.kind === 0) {
      const item = Buffer.alloc(9);
      item[0] = 0; item.writeUInt32BE(op.offset, 1); item.writeUInt32BE(op.length, 5);
      encoded.push(item);
    } else {
      const item = Buffer.alloc(5);
      item[0] = 1; item.writeUInt32BE(op.data.length, 1);
      encoded.push(item, op.data);
    }
  }
  return Buffer.concat(encoded);
}

export function applyDelta(source, patch) {
  bounded(source);
  if (!Buffer.isBuffer(patch) || patch.length < HEADER_BYTES || patch.length > MAX_BYTES + HEADER_BYTES + MAX_OPERATIONS * 9)
    throw Error('Invalid delta');
  if (!patch.subarray(0, MAGIC.length).equals(MAGIC) ||
      !patch.subarray(MAGIC.length, MAGIC.length + 32).equals(sha256(source))) throw Error('Delta base mismatch');
  const expected = patch.subarray(MAGIC.length + 32, MAGIC.length + 64);
  const targetBytes = patch.readUInt32BE(MAGIC.length + 64);
  const operations = patch.readUInt32BE(MAGIC.length + 68);
  if (targetBytes < 1 || targetBytes > MAX_BYTES || operations < 1 || operations > MAX_OPERATIONS) throw Error('Invalid delta bounds');
  const output = Buffer.alloc(targetBytes);
  let cursor = HEADER_BYTES, written = 0;
  for (let i = 0; i < operations; i++) {
    if (cursor >= patch.length) throw Error('Truncated delta');
    const kind = patch[cursor++];
    if (kind === 0) {
      if (cursor + 8 > patch.length) throw Error('Truncated delta');
      const offset = patch.readUInt32BE(cursor), length = patch.readUInt32BE(cursor + 4);
      cursor += 8;
      if (!length || offset > source.length || length > source.length - offset ||
          length > targetBytes - written) throw Error('Invalid delta copy');
      source.copy(output, written, offset, offset + length);
      written += length;
    } else if (kind === 1) {
      if (cursor + 4 > patch.length) throw Error('Truncated delta');
      const length = patch.readUInt32BE(cursor); cursor += 4;
      if (!length || length > targetBytes - written || length > patch.length - cursor) throw Error('Invalid delta insert');
      patch.copy(output, written, cursor, cursor + length);
      cursor += length; written += length;
    } else throw Error('Invalid delta operation');
  }
  if (cursor !== patch.length || written !== targetBytes || !sha256(output).equals(expected))
    throw Error('Delta output mismatch');
  return output;
}
