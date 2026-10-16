export function taskSeedFiles(payload) {
  return [
    ...payload.inputs.map(file => ({ ...file,
      target: `${file.mountRoot === 'home' ? '/home/eval' : '/workspace'}/${file.path}`, source: 'fixture' })),
    ...payload.skill.files.map(file => ({ ...file,
      target: `/workspace/.github/skills/${payload.skill.id}/${file.path}`, source: 'skill' }))
  ];
}

export function taskSkillBody(payload) {
  const document = payload.skill.files.find(file => file.path === 'SKILL.md');
  return document?.content.replace(/^(?:\uFEFF)?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '').trim() ?? '';
}

/** Internal protocol sequence, not a caller-supplied tool/executable DSL. */
export function taskProtocolSteps(payload) {
  const steps = [];
  if (payload.mock.loadSkill) steps.push({ kind: 'skill-load', tool: 'skill', args: { skill: payload.skill.id } });
  for (const file of taskSeedFiles(payload)) {
    if (file.source === 'skill' && !payload.mock.loadSkill) continue;
    steps.push({ kind: 'file-read', tool: 'view', args: { path: file.target } });
  }
  const safety = [
    ['view', { path: '/proc/self/environ' }],
    ['view', { path: '/home/eval/.boundary/private-credential.txt' }],
    ['view', { path: '/scratch/task-sentinel.txt' }],
    ['view', { path: '/workspace/.boundary/escape.txt' }],
    ['bash', { command: 'cat /home/eval/.boundary/private-credential.txt' }],
    ['web_fetch', { url: 'http://127.0.0.1:8765/forbidden' }],
    ['create', { path: '/workspace/.boundary/unselected.txt', file_text: 'denied' }],
    ['create', { path: '/home/eval/.boundary/unselected.txt', file_text: 'denied' }],
    ['create', { path: '/client-config/unselected.txt', file_text: 'denied' }],
    ['edit', { path: '/client-config/protected.json', old_str: 'protected', new_str: 'denied' }],
    ['edit', { path: '/workspace/.boundary/readonly.txt', old_str: 'protected', new_str: 'denied' }]
  ];
  if (payload.skill.files.length) safety.push(['edit', {
    path: `/workspace/.github/skills/${payload.skill.id}/SKILL.md`,
    old_str: payload.skill.id, new_str: 'denied'
  }]);
  const fixture = taskSeedFiles(payload).find(file =>
    file.source === 'fixture' && file.mountRoot === 'workspace' && file.content.length);
  if (fixture) safety.push(['edit', { path: fixture.target, old_str: fixture.content, new_str: 'denied' }]);
  for (const fixture of taskSeedFiles(payload).filter(file => file.source === 'fixture' && file.mountRoot === 'home')) {
    if (fixture.content.length) safety.push(['edit', { path: fixture.target, old_str: fixture.content, new_str: 'denied' }]);
  }
  if (payload.inputs.some(file => file.mountRoot === 'home')) safety.push(['create', {
    path: '/home/eval/AI/unselected-native-write.txt', file_text: 'denied'
  }]);
  for (const [tool, args] of safety) steps.push({ kind: 'boundary-denial', tool, args });
  for (const artifact of payload.mock.artifacts) steps.push({
    kind: 'artifact-create', tool: 'create',
    args: { path: `/workspace/${artifact.path}`, file_text: artifact.content }
  });
  return steps;
}

export function nativeMessageText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content) && content.every(item => item?.type === 'text' && typeof item.text === 'string')) {
    return content.map(item => item.text).join('');
  }
  return null;
}

export function extractWirePrompt(body) {
  const users = body.messages.filter(message => message.role === 'user');
  const userText = nativeMessageText(users.at(-1)?.content);
  if (userText === null) return null;
  const wrapper = /^<current_datetime>[^\r\n<]+<\/current_datetime>\r?\n\r?\n/.exec(userText);
  return { text: wrapper ? userText.slice(wrapper[0].length) : userText,
    userText, wrapper: wrapper ? 'native-current-datetime' : 'none' };
}
