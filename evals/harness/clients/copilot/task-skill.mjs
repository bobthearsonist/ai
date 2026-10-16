import { insistTask } from './task-boundary.mjs';

export function validateTaskSkillDocument(file, id) {
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(file.content);
  insistTask(match && match[2].trim(), 'TASK_SKILL_INVALID', 'A genuine root SKILL.md with frontmatter and body is required');
  const name = /^name:[ \t]*(?:"([^"]+)"|'([^']+)'|([a-zA-Z0-9-]+))[ \t]*$/m.exec(match[1]);
  const description = /^description:[ \t]*([^\r\n]*)/m.exec(match[1]);
  insistTask(name && (name[1] ?? name[2] ?? name[3]) === id && description &&
    description[1].trim() && (!/^[>|][-+]?$/.test(description[1].trim()) ||
      /(?:^|\n)[ \t]+\S/.test(match[1].slice(description.index + description[0].length))),
  'TASK_SKILL_INVALID', 'SKILL.md must declare the selected name and a nonempty description');
  const contentKeys = new Set(['name', 'description', 'license', 'compatibility', 'metadata',
    'argument-hint', 'user-invocable', 'disable-model-invocation', 'version']);
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || /^[ \t#]/.test(line)) continue;
    const field = /^(?:"([a-zA-Z][a-zA-Z0-9_-]*)"|'([a-zA-Z][a-zA-Z0-9_-]*)'|([a-zA-Z][a-zA-Z0-9_-]*))[ \t]*:/.exec(line);
    insistTask(field && contentKeys.has((field[1] ?? field[2] ?? field[3]).toLowerCase()),
      'TASK_SKILL_CONTROL_PLANE_UNSUPPORTED',
      'Skill frontmatter may contain content/discovery metadata, not hooks, plugins, MCP, provider or permission directives');
  }
}
