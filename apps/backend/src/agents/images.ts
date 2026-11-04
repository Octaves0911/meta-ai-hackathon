// Screenshots attached in the review chat (Meta vision input): checked by their bytes, size-capped, never trusted by claimed type.
import { HttpError } from '../errors.js';

export const MAX_IMAGE_BYTES = 2_500_000;
export interface ChatImage { mime: 'image/png' | 'image/jpeg' | 'image/webp'; data: Buffer }

function sniff(b: Buffer): ChatImage['mime'] | null {
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

/** A `data:image/…;base64,…` string from the browser -> a verified image. */
export function parseChatImage(dataUrl: string): ChatImage {
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) throw new HttpError(400, 'invalid_image', 'attach a PNG, JPEG or WebP screenshot');
  if (m[2].length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 8) throw new HttpError(413, 'image_too_large', 'the screenshot is larger than 2.5 MB');
  const data = Buffer.from(m[2], 'base64');
  if (data.length === 0 || data.length > MAX_IMAGE_BYTES) throw new HttpError(413, 'image_too_large', 'the screenshot is larger than 2.5 MB');
  const mime = sniff(data);
  if (!mime) throw new HttpError(400, 'invalid_image', 'that file is not a PNG, JPEG or WebP image');
  return { mime, data };
}

export const toDataUrl = (mime: string, data: Buffer) => `data:${mime};base64,${data.toString('base64')}`;
