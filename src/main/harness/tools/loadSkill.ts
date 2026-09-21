// 读取一个已安装技能的正文。
//
// 技能是**纯文字**——SKILL.md 的 frontmatter + Markdown，讲「这类活儿该怎么做」。
// 装一个技能永远不会执行任何东西（见 knowledge/skills.ts 开头的说明），所以这
// 个工具是 read：它只是把一段说明搬进模型的上下文。
//
// 和 search_library 一样，能力一直在，断的是线：skills.ts 的注释指向 agent.ts
// 的 load_skill 工具，而 agent.ts 已经不存在了。用户能装技能，装完却没有任何
// 东西读得到——界面上那句「无可用 skill」一直在撒谎。
import { defineTool } from '@deepseek-ai/dsh-tools'
import { getSkillBody, listInstalledSkills } from '../../knowledge/skills'

export const loadSkill = defineTool({
	name: 'load_skill',
	description:
		'读取一个已安装技能的完整说明。技能是针对某类任务的做事方法，'
		+ '系统提示里列出了可用的名字和一句话简介；当某个技能与当前任务相关时，'
		+ '先加载它再动手。',
	parameters: {
		name: { type: 'string', required: true, description: '技能名，取自系统提示里列出的那些' },
	},
	output: {
		schema: { type: 'string' },
		render: (_args, value) => [{ type: 'text', text: value }],
	},
	async execute(args) {
		const name = args.name.trim()
		// getSkillBody 对非法名字会抛（路径穿越防护），这里先拦一道，让错误变成
		// 模型读得懂的反馈而不是异常。
		const known = listInstalledSkills().map((s) => s.name)
		if (!known.includes(name)) {
			return known.length
				? `no such skill "${name}". installed: ${known.join(', ')}`
				: `no such skill "${name}". no skills are installed.`
		}
		return getSkillBody(name) ?? `skill "${name}" has no readable body`
	},
})
