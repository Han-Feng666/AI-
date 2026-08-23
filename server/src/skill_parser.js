// 技能文件解析（SKILL.md 格式），纯函数、无副作用、不依赖数据库，可单元测试。
// 输入 { name, content }，成功返回 { name, description, content, tags }，失败返回 { error }。
export function parseSkillFile({ name = '', content = '' } = {}) {
  const raw = String(content ?? '');
  let skillName = String(name || '').replace(/\.(md|markdown|txt)$/i, '').trim();
  let description = '';
  let body = raw;
  let tags = '';

  const fmMatch = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (fmMatch) {
    const fm = fmMatch[1];
    const nameM = fm.match(/(?:^|\n)\s*name\s*:\s*(.+)\s*$/m);
    const descM = fm.match(/(?:^|\n)\s*description\s*:\s*(.+)\s*$/m);
    const tagsM = fm.match(/(?:^|\n)\s*tags\s*:\s*(.+)\s*$/m);
    if (nameM) skillName = String(nameM[1]).replace(/^["']|["']$/g, '').trim() || skillName;
    if (descM) description = String(descM[1]).replace(/^["']|["']$/g, '').trim();
    if (tagsM) tags = String(tagsM[1]).replace(/^["']|["']$/g, '').trim();
    body = raw.slice(fmMatch[0].length).trim();
  }
  // 去掉正文顶部的 "## What this skill does" 之类标题前的 # 一级标题（SKILL.md 惯例首个 # 是技能名标题）
  const titleM = body.match(/^\s*#\s+.+\n?/);
  if (titleM) body = body.replace(titleM[0], '').trim();
  body = body.replace(/^## /gm, '### ').trim();

  if (!skillName) return { error: '未解析到技能名称' };
  if (!body) return { error: '技能内容为空' };
  return { name: skillName, description, content: body, tags };
}