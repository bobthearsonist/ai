export function exactResourceAbsence(result, kind, identity) {
  if (result.exitCode !== 1 || !['container', 'volume'].includes(kind) ||
      typeof identity !== 'string' || !/^[a-z0-9-]+$/.test(identity) ||
      !['', '[]'].includes(result.stdout.trim())) return false;
  const pattern = kind === 'volume'
    ? `^(?:Error response from daemon: )?(?:get ${identity}: )?no such volume(?:: ${identity})?$`
    : `^(?:Error(?: response from daemon)?: )?No such (?:object|container): ${identity}$`;
  return new RegExp(pattern, 'i').test(result.stderr.trim());
}
