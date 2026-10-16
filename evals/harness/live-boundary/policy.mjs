import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { types } from 'node:util';
import { deepFreeze, insist } from './errors.mjs';

export const MAX_HOSTS = 32;
export const MAX_DNS_ANSWERS = 16;
const reserved = /(?:^|\.)(?:localhost|local|internal|lan|test|invalid|example|onion|home|arpa)$/;

export function canonicalHost(host) {
  insist(typeof host === 'string' && host.length >= 4 && host.length <= 253 &&
    /^[a-z0-9.-]+$/.test(host) && !isIP(host), 'INVALID_HOST');
  const labels = host.split('.');
  insist(labels.length >= 2 && labels.every(label =>
    label.length >= 1 && label.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label) && !label.startsWith('xn--')) &&
    /^[a-z]{2,63}$/.test(labels.at(-1)), 'INVALID_HOST');
  let parsed;
  try { parsed = new URL(`https://${host}`); } catch { insist(false, 'INVALID_HOST'); }
  insist(parsed.hostname === host && !parsed.username && !parsed.password &&
    parsed.pathname === '/' && !parsed.port, 'INVALID_HOST');
  return host;
}

export function createPublicPolicy(hosts) {
  insist(Array.isArray(hosts) && !types.isProxy(hosts) &&
    Object.getPrototypeOf(hosts) === Array.prototype && hosts.length >= 1 && hosts.length <= MAX_HOSTS &&
    Reflect.ownKeys(hosts).every(key => typeof key === 'string' &&
      (key === 'length' || (/^(?:0|[1-9]\d*)$/.test(key) && Number(key) < hosts.length))) &&
    Object.values(Object.getOwnPropertyDescriptors(hosts)).every(item => Object.hasOwn(item, 'value')) &&
    Array.from({ length: hosts.length }, (_, index) => Object.hasOwn(hosts, index)).every(Boolean) &&
    new Set(hosts).size === hosts.length, 'INVALID_POLICY');
  const names = hosts.map(host => {
    canonicalHost(host);
    insist(!reserved.test(host), 'INVALID_HOST');
    return host;
  }).sort();
  return routingPolicy(names, 'public-exact-dns-tls-443');
}

export function routingPolicy(hosts, issuer) {
  insist(Array.isArray(hosts) && hosts.length >= 1 && hosts.length <= MAX_HOSTS &&
    hosts.every(host => canonicalHost(host)) &&
    ['public-exact-dns-tls-443', 'local-fixture-issuer-only'].includes(issuer), 'INVALID_POLICY');
  const specification = {
    version: 1, issuer, hosts: [...hosts].sort(), port: 443,
    authorityMatchesSNI: true, encryptedClientHello: 'reject',
    framing: 'bounded-complete-single-client-hello',
    dns: issuer === 'public-exact-dns-tls-443' ? 'all-global-repeat-and-pin' : 'exact-owned-fixture-address'
  };
  const policyHash = createHash('sha256').update(JSON.stringify(specification)).digest('hex');
  return deepFreeze({ ...specification, policyHash });
}

function ipv6Number(address) {
  const sides = address.toLowerCase().split('::');
  insist(sides.length <= 2 && !address.includes('.') && !address.includes('%'), 'DNS_NONPUBLIC');
  const left = sides[0] ? sides[0].split(':') : [];
  const right = sides.length === 2 && sides[1] ? sides[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  insist((sides.length === 2 ? missing >= 1 : missing === 0) &&
    [...left, ...right].every(part => /^[a-f0-9]{1,4}$/.test(part)), 'DNS_NONPUBLIC');
  return [...left, ...Array(missing).fill('0'), ...right]
    .reduce((value, part) => (value << 16n) | BigInt(`0x${part}`), 0n);
}

export function addressKey(address) {
  insist(typeof address === 'string' && isIP(address) !== 0 && !address.includes('%'), 'DNS_NONPUBLIC');
  if (isIP(address) === 4) return `4:${address}`;
  return `6:${ipv6Number(address).toString(16).padStart(32, '0')}`;
}

export function assertPublicAddress(address) {
  const key = addressKey(address);
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    insist(!(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 192 && b === 88 && c === 99) || (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113) ||
      address === '168.63.129.16'), 'DNS_NONPUBLIC');
  } else {
    const value = ipv6Number(address);
    insist(value >> 125n === 1n &&
      value >> 105n !== ipv6Number('2001::') >> 105n &&
      value >> 96n !== ipv6Number('2001:db8::') >> 96n &&
      value >> 112n !== ipv6Number('2002::') >> 112n &&
      value >> 108n !== ipv6Number('3fff::') >> 108n, 'DNS_NONPUBLIC');
  }
  return key;
}

export function validateAnswerSet(addresses, authorize = assertPublicAddress) {
  insist(Array.isArray(addresses) && addresses.length >= 1 && addresses.length <= MAX_DNS_ANSWERS,
    'DNS_UNRESOLVED');
  const unique = new Map();
  for (const address of addresses) {
    const key = authorize(address);
    insist(typeof key === 'string' && key === addressKey(address), 'DNS_NONPUBLIC');
    unique.set(key, address);
  }
  return [...unique.keys()].sort();
}

export function verifyAnswerSets(first, second, authorize = assertPublicAddress) {
  const before = validateAnswerSet(first, authorize);
  const after = validateAnswerSet(second, authorize);
  insist(before.length === after.length && before.every((key, index) => key === after[index]), 'DNS_REBINDING');
  return before;
}

export function assertConnectedPeer(expected, observed, authorize = assertPublicAddress) {
  const key = authorize(expected);
  insist(key === addressKey(observed), 'PEER_MISMATCH');
}
