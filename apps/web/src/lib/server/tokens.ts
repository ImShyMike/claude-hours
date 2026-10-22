// 32 random bytes, base64url: cookies, device codes and device tokens
export function randomToken(prefix = '') {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return prefix + Buffer.from(bytes).toString('base64url')
}
