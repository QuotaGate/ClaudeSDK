import { createHash, createHmac, randomBytes } from 'node:crypto';

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function hmacSha256Hex(key: string | Uint8Array, data: string | Uint8Array): string {
  return createHmac('sha256', key).update(data).digest('hex');
}

/**
 * Deterministic JSON: object keys sorted, no whitespace. Non-JSON values (undefined,
 * functions, symbols) are dropped as JSON.stringify would; non-finite numbers become null.
 * Cycles are replaced with null so hashing never throws on odd tool inputs.
 */
export function canonicalJson(value: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') {
      if (typeof v === 'number' && !Number.isFinite(v)) return null;
      if (typeof v === 'bigint') return v.toString();
      return v;
    }
    if (seen.has(v)) return null;
    seen.add(v);
    let out: unknown;
    if (Array.isArray(v)) {
      out = v.map((x) => {
        const w = walk(x);
        return w === undefined || typeof w === 'function' || typeof w === 'symbol' ? null : w;
      });
    } else if (v instanceof Date) {
      out = v.toISOString();
    } else {
      const obj: Record<string, unknown> = {};
      for (const key of Object.keys(v).sort()) {
        const w = walk((v as Record<string, unknown>)[key]);
        if (w !== undefined && typeof w !== 'function' && typeof w !== 'symbol') obj[key] = w;
      }
      out = obj;
    }
    seen.delete(v);
    return out;
  };
  return JSON.stringify(walk(value)) ?? 'null';
}

/** UUID v7 (time-ordered), RFC 9562. */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  const ts = BigInt(now);
  for (let i = 0; i < 6; i++) bytes[i] = Number((ts >> BigInt(8 * (5 - i))) & 0xffn);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
