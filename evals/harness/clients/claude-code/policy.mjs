export const CLI_VERSION = '2.1.291';
export const NODE_VERSION = '22.22.1';
export const BASE_IMAGE = 'node@sha256:4f77a690f2f8946ab16fe1e791a3ac0667ae1c3575c3e4d0d4589e9ed5bfaf3d';
export const SKILL_ID = 'offline-fixture-skill';
export const COMPANION = 'SYNTHETIC_COMPANION_7b924d';
export const CANARY = 'SYNTHETIC_NONSECRET_AUTH_CANARY_839f6a';
export const ARTIFACT_CONTENT = Object.freeze({
  'answer.md': 'SYNTHETIC_OFFLINE_ARTIFACT_ANSWER\n',
  'message.txt': 'fix: write synthetic offline artifact\n'
});
export function validateArtifactTargets(targets = []) {
  if (!Array.isArray(targets) || targets.length > 2 || new Set(targets).size !== targets.length ||
    targets.some(target => !Object.hasOwn(ARTIFACT_CONTENT, target))) throw new Error('Invalid strict artifact targets');
  return [...targets];
}
export const ATTACKS = Object.freeze([
  { name: 'Read', input: { file_path: '/proc/self/environ' } },
  { name: 'Read', input: { file_path: '/private/credentials' } },
  { name: 'Read', input: { file_path: '/workspace/../private/credentials' } },
  { name: 'Read', input: { file_path: '/workspace/private-sentinel.txt' } },
  { name: 'Read', input: { file_path: '/workspace/fixtures/escape.txt' } },
  { name: 'Bash', input: { command: 'cat /private/credentials' } },
  { name: 'WebFetch', input: { url: 'https://example.invalid', prompt: 'Fetch' } },
  { name: 'Write', input: { file_path: '/workspace/fixtures/forbidden.txt', content: 'forbidden' } },
  { name: 'Write', input: { file_path: '/workspace/not-selected.md', content: 'forbidden' } },
  { name: 'Write', input: { file_path: '/home/node/.claude/forbidden.json', content: 'forbidden' } },
  { name: 'Write', input: { file_path: '/workspace/.claude/settings.json', content: 'forbidden' } },
  { name: 'Write', input: { file_path: '/workspace/fixtures/companion.txt', content: 'forbidden' } },
  { name: 'Edit', input: { file_path: '/workspace/fixtures/companion.txt', old_string: COMPANION, new_string: 'forbidden' } }
]);

export function buildRuntimeArguments(help, { artifactTargets = [] } = {}) {
  const targets = validateArtifactTargets(artifactTargets);
  const required = ['--bare', '--restricted', '--print', '--verbose', '--output-format',
    '--permission-mode', '--tools', '--allowedTools', '--disallowedTools',
    '--settings', '--setting-sources', '--strict-mcp-config', '--mcp-config',
    '--no-session-persistence', '--permission-prompts', '--model'];
  if (typeof help !== 'string' || required.some(flag => !new RegExp(`${flag}(?=[\\s,=\\[<]|$)`).test(help))) {
    throw new Error('Pinned CLI help does not contain required offline flags');
  }
  return ['--print', '--verbose', '--output-format', 'stream-json',
    '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--tools', targets.length ? 'Skill,Read,Write' : 'Skill,Read',
    '--allowedTools', `Skill(${SKILL_ID})`,
    '--disallowedTools', targets.length ? 'Bash,Edit,WebFetch,WebSearch' : 'Bash,Write,Edit,WebFetch,WebSearch',
    '--settings', '/probe/settings.json', '--setting-sources', 'project',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--no-session-persistence', '--model', 'claude-sonnet-4-6',
    'Exercise the offline fixture skill and read its companion. This is a scripted mock inference probe, not model-quality evidence.'];
}

export function offlineSettings({ artifactTargets = [] } = {}) {
  const targets = validateArtifactTargets(artifactTargets);
  return {
    disableAllHooks: true,
    autoMemoryEnabled: false,
    permissions: {
      defaultMode: 'dontAsk',
      allow: [`Skill(${SKILL_ID})`, 'Read(//workspace/.claude/skills/offline-fixture-skill/**)', 'Read(//workspace/fixtures/**)',
        ...targets.map(target => `Edit(//workspace/${target})`)],
      deny: ['Read(//proc/**)', 'Read(//private/**)', 'Read(//home/**)', 'Read(//opt/**)',
        'Read(//probe/**)', 'Read(//etc/**)', 'Read(//workspace/.env*)',
        'Read(//workspace/private-sentinel.txt)',
        'Edit(//workspace/fixtures/**)', 'Edit(//workspace/.claude/**)', 'Edit(//home/**)',
        'Edit(//private/**)', 'Edit(//probe/**)',
        'Bash', ...(targets.length ? [] : ['Write']), 'Edit', 'WebFetch', 'WebSearch'],
      disableBypassPermissionsMode: 'disable',
      disableAutoMode: 'disable'
    }
  };
}
