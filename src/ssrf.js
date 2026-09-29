// SSRF protection for user-supplied model API base URLs.
// A user could otherwise point the bot at VPS-internal addresses
// (localhost, metadata service, other apps' ports) and make the
// server fetch them.
const dns = require('dns').promises;
const net = require('net');

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    return (
      p[0] === 10 ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) ||
      p[0] === 127 ||
      p[0] === 0 ||
      (p[0] === 169 && p[1] === 254) // cloud metadata (169.254.169.254)
    );
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    return (
      l === '::1' || l === '::' ||
      l.startsWith('fc') || l.startsWith('fd') || // unique local
      l.startsWith('fe80') // link-local
    );
  }
  return true; // unrecognized -> treat as unsafe
}

// Synchronous check: literal private IPs in the URL. Cheap enough to run
// on every model call (no DNS involved).
function assertSafeUrlSync(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('URL ပုံစံမမှန်ပါ။'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('http(s) ပဲ ရပါတယ်။');
  if (u.username || u.password) throw new Error('URL မှာ username/password မပါရပါ။');
  // strip IPv6 brackets: new URL keeps them in .hostname ("[::1]")
  const host = u.hostname.replace(/^\[(.*)\]$/, '$1');
  if (net.isIP(host) && isPrivateIp(host)) {
    throw new Error('internal/private server တွေ ချိတ်လို့မရပါ။');
  }
}

// Full async validation (with DNS resolution of the hostname).
// Returns null when OK, or a Burmese error message.
async function validateBaseUrl(raw) {
  try { assertSafeUrlSync(raw); }
  catch (e) { return e.message; }
  const host = new URL(raw).hostname.replace(/^\[(.*)\]$/, '$1');
  if (net.isIP(host)) return null; // already checked above
  let addrs;
  try { addrs = await dns.lookup(host, { all: true }); }
  catch { return 'hostname ကို resolve လုပ်မရပါ။'; }
  if (!addrs.length) return 'hostname ကို resolve လုပ်မရပါ။';
  for (const a of addrs) {
    if (isPrivateIp(a.address)) return 'internal/private server တွေ ချိတ်လို့မရပါ။';
  }
  return null;
}

module.exports = { validateBaseUrl, assertSafeUrlSync, isPrivateIp };
