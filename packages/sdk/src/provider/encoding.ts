/**
 * Web-standard binary/text codecs for the Workers-safe provider entry points.
 * The implementation lives in `internal/encoding.ts` so the client and the
 * provider share one set of helpers; this module keeps the original path.
 */
export {
  base64ToUtf8,
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  bytesToUtf8,
  hexToBytes,
  utf8ToBase64,
  utf8ToBytes,
} from '../internal/encoding.js'
