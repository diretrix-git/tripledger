export interface CryptoLike {
  randomUUID?: () => string;
  getRandomValues?: <T extends ArrayBufferView>(array: T) => T;
}

const BYTE_TO_HEX: string[] = Array.from({ length: 256 }, (_, i) =>
  i.toString(16).padStart(2, '0')
);

/**
 * Generates an RFC 4122 version 4 UUID using cryptographically secure primitives.
 *
 * - Prefers `crypto.randomUUID()` when available (HTTPS and `localhost` secure contexts).
 * - Falls back to `crypto.getRandomValues()` when `randomUUID` is omitted by the browser
 *   (such as on plain `http://<LAN-IP>` non-secure contexts on mobile/desktop browsers).
 * - Never falls back to `Math.random()`. Fails closed if neither CSPRNG API is present.
 */
export function generateUUID(cryptoOverride?: CryptoLike | null): string {
  const cryptoObj: CryptoLike | null | undefined =
    cryptoOverride !== undefined
      ? cryptoOverride
      : typeof globalThis !== 'undefined'
        ? (globalThis as { crypto?: CryptoLike }).crypto
        : undefined;

  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID();
  }

  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    cryptoObj.getRandomValues(bytes);

    // Per RFC 4122 section 4.4:
    // - Set version 4 (0100xxxx in octet 6)
    // - Set variant 1 (10xxxxxx in octet 8)
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;

    return (
      BYTE_TO_HEX[bytes[0]!]! +
      BYTE_TO_HEX[bytes[1]!]! +
      BYTE_TO_HEX[bytes[2]!]! +
      BYTE_TO_HEX[bytes[3]!]! +
      '-' +
      BYTE_TO_HEX[bytes[4]!]! +
      BYTE_TO_HEX[bytes[5]!]! +
      '-' +
      BYTE_TO_HEX[bytes[6]!]! +
      BYTE_TO_HEX[bytes[7]!]! +
      '-' +
      BYTE_TO_HEX[bytes[8]!]! +
      BYTE_TO_HEX[bytes[9]!]! +
      '-' +
      BYTE_TO_HEX[bytes[10]!]! +
      BYTE_TO_HEX[bytes[11]!]! +
      BYTE_TO_HEX[bytes[12]!]! +
      BYTE_TO_HEX[bytes[13]!]! +
      BYTE_TO_HEX[bytes[14]!]! +
      BYTE_TO_HEX[bytes[15]!]!
    );
  }

  throw new Error('Cryptographically secure UUID generation is unavailable in this environment.');
}
