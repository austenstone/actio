// Encode/decode playground source in the URL hash so links are shareable.
// Uses base64url over UTF-8 bytes so the hash survives copy/paste and unicode.

const HASH_KEY = 'code';

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function encodeSource(source: string): string {
  return bytesToBase64Url(new TextEncoder().encode(source));
}

export function decodeSource(encoded: string): string | null {
  try {
    return new TextDecoder().decode(base64UrlToBytes(encoded));
  } catch {
    return null;
  }
}

/** Read the source from the current URL hash, if present. */
export function readSourceFromHash(): string | null {
  if (typeof window === 'undefined') return null;
  const hash = window.location.hash.replace(/^#/, '');
  const params = new URLSearchParams(hash);
  const encoded = params.get(HASH_KEY);
  return encoded ? decodeSource(encoded) : null;
}

/** Replace the hash with the encoded source without triggering navigation. */
export function writeSourceToHash(source: string): void {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams();
  params.set(HASH_KEY, encodeSource(source));
  const { pathname, search } = window.location;
  // basePath is already baked into pathname, so href stays correct on GitHub Pages.
  window.history.replaceState(null, '', `${pathname}${search}#${params.toString()}`);
}
