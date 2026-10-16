import { FIXTURE_HOME, seedPaths } from './case-spec.mjs';

export function buildRestrictedTaskConfig(spec) {
  const files = seedPaths(spec);
  const homeDirectories = new Set(files.filter(file => file.filePath.startsWith(`${FIXTURE_HOME}/`))
    .map(file => file.filePath.slice(0, file.filePath.lastIndexOf('/'))));
  return {
    autoupdate: false, share: 'disabled', plugin: [], mcp: {}, instructions: [],
    formatter: false, lsp: false, snapshot: false, compaction: { auto: false, prune: false },
    permission: {
      '*': 'deny',
      skill: { '*': 'deny', [spec.skill.id]: 'allow' },
      read: { '*': 'deny', ...Object.fromEntries(files.map(file => [file.filePath, 'allow'])) },
      edit: { '*': 'deny',
        ...Object.fromEntries(spec.artifactTargets.map(target => [`work/project/${target}`, 'allow'])) },
      // Native external-directory permission uses directory/*; Read still matches exact files only.
      external_directory: { '*': 'deny',
        ...Object.fromEntries([...homeDirectories].map(directory => [`${directory}/*`, 'allow'])) }
    }
  };
}
