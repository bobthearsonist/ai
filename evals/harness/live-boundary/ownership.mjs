import { deepFreeze, insist } from './errors.mjs';
import { measureNativeToolTransportMount } from './tool-transport.mjs';

export const OWNER_LABEL = 'ai.skill-eval.egress.owner';
export const ROLE_LABEL = 'ai.skill-eval.egress.role';
export const ISSUER_LABEL = 'ai.skill-eval.egress.issuer';
export const CANDIDATE_LABEL = 'ai.skill-eval.egress.candidate';
export const INTERNAL_OPTIONS = Object.freeze({
  'com.docker.network.bridge.gateway_mode_ipv4': 'isolated',
  'com.docker.network.bridge.enable_ip_masquerade': 'false'
});

export function isExactResourceAbsence(result, expected) {
  if (result.exitCode !== 1) return false;
  const text = result.stderr.trim();
  const missing = /^(?:Error(?: response from daemon)?: )?No such (?:object|container|network): ([a-z0-9-]+)$/.exec(text);
  const network = expected.kind === 'network'
    ? /^(?:Error response from daemon: )?network ([a-z0-9-]+) not found$/.exec(text) : null;
  const identity = (missing ?? network)?.[1];
  return identity !== undefined && [expected.id, expected.name].includes(identity);
}

export function validateOwnedContainerIdentity(container, expected) {
  insist(container?.Id === expected.id && container.Name === `/${expected.name}` &&
    container.Config?.Labels?.[OWNER_LABEL] === expected.owner &&
    container.Config.Labels[ROLE_LABEL] === expected.role &&
    container.Config.Labels[ISSUER_LABEL] === expected.issuer, 'OWNERSHIP_MISMATCH');
  if (expected.candidateId) {
    insist(container.Config.Labels[CANDIDATE_LABEL] === expected.candidateId, 'OWNERSHIP_MISMATCH');
  }
  return container;
}

export function validateOwnedContainer(container, expected) {
  validateOwnedContainerIdentity(container, expected);
  const networks = Object.values(container.NetworkSettings?.Networks ?? {}).map(network => network.NetworkID).sort();
  insist(JSON.stringify(networks) === JSON.stringify([...expected.networkIds].sort()), 'OWNERSHIP_MISMATCH');
  return container;
}

export function observedNetworkIds(container, networks) {
  return Object.entries(container.NetworkSettings?.Networks ?? {}).map(([name, value]) => {
    if (value.NetworkID) return value.NetworkID;
    insist(container.State?.Status === 'created' && container.State.Running === false, 'OWNERSHIP_MISMATCH');
    const network = networks.find(item => item.name === name || item.id === name);
    insist(network, 'OWNERSHIP_MISMATCH');
    return network.id;
  });
}

export function validateOwnedNetwork(network, expected) {
  insist(network?.Id === expected.id && network.Name === expected.name &&
    network.Labels?.[OWNER_LABEL] === expected.owner &&
    network.Labels[ROLE_LABEL] === expected.role &&
    network.Labels[ISSUER_LABEL] === expected.issuer, 'OWNERSHIP_MISMATCH');
  insist(network.Driver === 'bridge' && network.Scope === 'local' &&
    network.Internal === expected.internal && network.EnableIPv6 === false, 'NETWORK_MISMATCH');
  if (expected.internal) {
    insist(Object.entries(INTERNAL_OPTIONS).every(([key, value]) => network.Options?.[key] === value),
      'NETWORK_MISMATCH');
  }
  return network;
}

export function validateAttachmentGraph(networks, containers, expectedContainers) {
  const ownedIds = new Set(expectedContainers.map(item => item.id));
  for (const network of networks) {
    const actual = Object.keys(network.Containers ?? {}).sort();
    const expected = expectedContainers.filter(item => item.networkIds.includes(network.Id)).map(item => item.id).sort();
    insist(actual.every(id => ownedIds.has(id)) && JSON.stringify(actual) === JSON.stringify(expected),
      'OWNERSHIP_MISMATCH');
  }
  for (const expected of expectedContainers) {
    const container = containers.find(item => item.Id === expected.id);
    validateOwnedContainer(container, expected);
  }
}

export function measureConfinement(container, expected) {
  validateOwnedContainer(container, expected);
  const host = container.HostConfig;
  insist(container.Image === expected.imageId && container.Config.User === (expected.user ?? '10001:10001') &&
    host.ReadonlyRootfs === true && host.Privileged === false &&
    host.CapDrop?.length === 1 && ['ALL', 'CAP_ALL'].includes(host.CapDrop[0]) &&
    host.CapAdd === null && host.SecurityOpt?.length === 1 &&
    host.SecurityOpt[0] === 'no-new-privileges=true' &&
    host.Memory === (expected.memoryBytes ?? 268435456) &&
    host.MemorySwap === (expected.memoryBytes ?? 268435456) && host.PidsLimit === (expected.pidsLimit ?? 64) &&
    host.NanoCpus === 1000000000 && host.LogConfig?.Type === 'none' &&
    host.IpcMode === 'none' && !host.PidMode && !host.UTSMode &&
    Object.keys(host.PortBindings ?? {}).length === 0 &&
    (host.Devices ?? []).length === 0 && (host.DeviceRequests ?? []).length === 0 &&
    (host.ExtraHosts ?? []).length === 0 && (host.Links ?? []).length === 0 &&
    (host.VolumesFrom ?? []).length === 0 &&
    host.RestartPolicy?.Name === 'no', 'CONFIG_MISMATCH');
  if (expected.nativeLayout) {
    insist(container.Config.WorkingDir === expected.nativeLayout.workdir &&
      JSON.stringify(container.Config.Entrypoint) === JSON.stringify(expected.nativeLayout.entrypoint) &&
      JSON.stringify(container.Config.Cmd) === JSON.stringify(expected.nativeLayout.command), 'CONFIG_MISMATCH');
  }
  insist(JSON.stringify([...container.Config.Env].sort()) === JSON.stringify([...expected.env].sort()),
    'CONFIG_MISMATCH');
  const mounts = container.Mounts ?? [];
  const transport = expected.toolTransport;
  const transportObservation = transport ? measureNativeToolTransportMount(container, transport) : null;
  const bindMounts = transport ? mounts.filter(mount => mount.Type === 'bind') : mounts;
  const tmpfs = expected.tmpfs ?? {
    '/scratch': 'rw,noexec,nosuid,nodev,size=16m,mode=700,uid=10001,gid=10001'
  };
  insist(mounts.length === expected.mounts.length + (transport ? 1 : 0) &&
    bindMounts.length === expected.mounts.length &&
    bindMounts.every(mount => mount.Type === 'bind' && mount.RW === false &&
      expected.mounts.some(item => item.destination === mount.Destination)) &&
    JSON.stringify(Object.keys(host.Tmpfs ?? {}).sort()) === JSON.stringify(Object.keys(tmpfs).sort()) &&
    Object.entries(tmpfs).every(([target, options]) =>
      host.Tmpfs[target]?.split(',').sort().join(',') === options.split(',').sort().join(',')), 'CONFIG_MISMATCH');
  const binds = transport ? (host.Mounts ?? []).filter(mount => mount.Type === 'bind') : host.Mounts ?? [];
  if (transport) insist(expected.nativeLayout && expected.role === 'native-candidate' &&
    host.Mounts.length === expected.mounts.length + 1, 'TOOL_TRANSPORT_MOUNT_MISMATCH');
  insist(binds.length === expected.mounts.length && expected.mounts.every(item =>
    binds.some(mount => mount.Type === 'bind' && mount.Source === item.source &&
      mount.Target === item.destination && mount.ReadOnly === true &&
      mount.BindOptions?.NonRecursive === true)), 'CONFIG_MISMATCH');
  if (expected.role === 'candidate' || expected.role === 'native-candidate') {
    insist(host.Dns?.length === 1 && host.Dns[0] === '127.0.0.1' &&
      host.Sysctls?.['net.ipv6.conf.all.disable_ipv6'] === '1' &&
      host.Sysctls?.['net.ipv6.conf.default.disable_ipv6'] === '1', 'CONFIG_MISMATCH');
  }
  return deepFreeze({
    id: container.Id, role: expected.role, imageId: container.Image,
    rootfsReadOnly: true, user: container.Config.User, capDrop: [...host.CapDrop],
    noNewPrivileges: true, memoryBytes: host.Memory, memorySwapBytes: host.MemorySwap,
    nanoCpus: host.NanoCpus, pidsLimit: host.PidsLimit, logging: host.LogConfig.Type,
    hostPorts: [], networkIds: [...expected.networkIds],
    mounts: expected.mounts.map(item => ({ destination: item.destination, readOnly: true })),
    ...(transport ? { toolTransport: transportObservation } : {}),
    tmpfs, dns: [...(host.Dns ?? [])], running: container.State?.Running === true,
    ...(expected.nativeLayout ? {
      nativeProcessConfiguration: {
        workdir: container.Config.WorkingDir, entrypoint: [...container.Config.Entrypoint],
        command: [...container.Config.Cmd]
      }
    } : {})
  });
}
