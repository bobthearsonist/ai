import { hashContent } from '../../index.mjs';
import { TASK_CAPS } from './task-boundary.mjs';

function xmlText(value) {
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/u.test(value) ||
    value.includes(']]>') ||
    /&(?!amp;|lt;|gt;|quot;|apos;|#(?:[0-9]+|x[0-9a-fA-F]+);)/.test(value)) return null;
  return value.replace(/&(?:amp|lt|gt|quot|apos|#(?:[0-9]+|x[0-9a-fA-F]+));/g, entity => {
    const simple = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
    if (Object.hasOwn(simple, entity)) return simple[entity];
    const numeric = entity.slice(2, -1);
    const point = numeric.startsWith('x') ? parseInt(numeric.slice(1), 16) : Number(numeric);
    if (!Number.isSafeInteger(point) || !(point === 9 || point === 10 || point === 13 ||
      point >= 0x20 && point <= 0xd7ff || point >= 0xe000 && point <= 0xfffd ||
      point >= 0x10000 && point <= 0x10ffff)) throw new Error('Invalid XML character');
    return String.fromCodePoint(point);
  });
}

/**
 * The pinned CLI can emit startup discovery before its JSONL sink is attached
 * when --add-dir is used. Its complete first-request system catalog is an
 * independent native discovery audit, not assistant text or mock metadata.
 */
export function nativeWireDiscovery(wire, firstRequest) {
  if (!wire || wire.requestHash !== firstRequest?.sha256 ||
    wire.catalogSourceRole !== 'system' || wire.catalogCount !== 1 || wire.catalogMarkerCount !== 2 ||
    !Array.isArray(wire.systemMessageHashes) || !wire.systemMessageHashes.length ||
    !wire.systemMessageHashes.every(hash => /^[a-f0-9]{64}$/.test(hash)) ||
    !Array.isArray(wire.catalogs) || wire.catalogs.length !== 1 ||
    !Array.isArray(wire.catalogSystemMessageIndices) || wire.catalogSystemMessageIndices.length !== 1 ||
    !Number.isSafeInteger(wire.catalogSystemMessageIndices[0]) || wire.catalogSystemMessageIndices[0] < 0 ||
    wire.catalogSystemMessageIndices[0] >= wire.systemMessageHashes.length ||
    wire.skillSchema?.name !== 'skill' ||
    wire.skillSchema.parameters?.properties?.skill?.type !== 'string') return null;
  const catalog = wire.catalogs[0];
  if (typeof catalog !== 'string' || Buffer.byteLength(catalog) > 32768) return null;
  const outer = /^<available_skills>\s*([\s\S]*?)\s*<\/available_skills>$/.exec(catalog);
  if (!outer) return null;
  const entries = [...outer[1].matchAll(/<skill>[\s\S]*?<\/skill>/g)];
  if (!entries.length || entries.length > TASK_CAPS.files + 2 ||
    outer[1].replace(/<skill>[\s\S]*?<\/skill>/g, '').trim()) return null;
  const skills = [];
  const names = new Set();
  try {
    for (const [entry] of entries) {
      const fields = /^<skill>\s*<name>([^<]*)<\/name>\s*<description>([^<]*)<\/description>\s*<location>(project|builtin)<\/location>\s*<\/skill>$/.exec(entry);
      if (!fields) return null;
      const name = xmlText(fields[1]), description = xmlText(fields[2]);
      if (!name || !description?.trim() || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) ||
        names.has(name)) return null;
      names.add(name);
      skills.push({ name, description, source: fields[3] });
    }
  } catch { return null; }
  return {
    source: 'actual-first-provider-request-system-available_skills',
    requestHash: wire.requestHash, systemMessageHashes: [...wire.systemMessageHashes],
    catalogSystemMessageIndex: wire.catalogSystemMessageIndices[0],
    catalogSystemMessageHash: wire.systemMessageHashes[wire.catalogSystemMessageIndices[0]],
    catalogHash: hashContent(catalog), catalog, skills
  };
}
