/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IDirectoryStrService } from '../directoryStrService.js';
import { StagingSelectionItem } from '../chatThreadServiceTypes.js';
import { os } from '../helpers/systemInfo.js';
import { RawToolParamsObj } from '../sendLLMMessageTypes.js';
import { approvalTypeOfBuiltinToolName, BuiltinToolCallParams, BuiltinToolName, BuiltinToolResultType, ToolName } from '../toolsServiceTypes.js';
import { ChatMode } from '../voidSettingsTypes.js';
import { LineNumberService } from '../../browser/helpers/LineNumberService.js'

// Triple backtick wrapper used throughout the prompts for code blocks
export const tripleTick = ['```', '```']

// Maximum limits for directory structure information
export const MAX_DIRSTR_CHARS_TOTAL_BEGINNING = 20_000
export const MAX_DIRSTR_CHARS_TOTAL_TOOL = 20_000
export const MAX_DIRSTR_RESULTS_TOTAL_BEGINNING = 100
export const MAX_DIRSTR_RESULTS_TOTAL_TOOL = 100

// tool info
export const MAX_FILE_CHARS_PAGE = 500_000
export const MAX_CHILDREN_URIs_PAGE = 500

// terminal tool info
export const MAX_TERMINAL_CHARS = 100_000
export const MAX_TERMINAL_INACTIVE_TIME = 8 // seconds
export const MAX_TERMINAL_BG_COMMAND_TIME = 5


// Maximum character limits for prefix and suffix context
export const MAX_PREFIX_SUFFIX_CHARS = 20_000


export const ORIGINAL = `<<<<<<< ORIGINAL`
export const DIVIDER = `=======`
export const FINAL = `>>>>>>> UPDATED`



const searchReplaceBlockTemplate = `\
${ORIGINAL}
// ... original code without rowindex goes here
${DIVIDER}
// ... final code without rowindex goes here
${FINAL}

${ORIGINAL}
// ... original code without rowindex goes here
${DIVIDER}
// ... final code without rowindex goes here
${FINAL}`




const createSearchReplaceBlocks_systemMessage = `\
你是一个编程助手，接收diff信息并输出SEARCH/REPLACE代码块来实现diff中的更改。
diff将被标记为\`DIFF\`，原始文件将被标记为\`ORIGINAL_FILE\`。

按以下格式组织你的SEARCH/REPLACE块：
${tripleTick[0]}
${searchReplaceBlockTemplate}
${tripleTick[1]}

1. 你的SEARCH/REPLACE块必须完全实现diff。不要遗漏任何内容。

2. 你可以输出多个SEARCH/REPLACE块来实现更改。

3. 假设diff中的任何注释都是更改的一部分。在输出中包含它们。

4. 你的输出应该只包含SEARCH/REPLACE块。不要在此之前或之后输出任何文本或解释。

5. 每个SEARCH/REPLACE块中的ORIGINAL必须是精确的原文行。不要添加或删除原始代码中的任何空格或注释，否则查找不到导致error。

6. 每个ORIGINAL文本必须足够大以唯一标识文件中的更改。但是，倾向于尽可能少写。

7. 每个ORIGINAL文本必须与所有其他ORIGINAL文本不相交。

## 示例 1
DIFF
${tripleTick[0]}
// ... existing code
let x = 6.5
// ... existing code
${tripleTick[1]}

ORIGINAL_FILE
${tripleTick[0]}
let w = 5
let x = 6
${tripleTick[1]}

接受的输出
${tripleTick[0]}
${ORIGINAL}
let x = 6
${DIVIDER}
let x = 6.5
${FINAL}
${tripleTick[1]}`


const replaceTool_description = `\
一个将应用于给定文件的SEARCH/REPLACE块字符串。
你的SEARCH/REPLACE块字符串必须按以下格式组织：
${searchReplaceBlockTemplate}

## 指导原则：

1. 如果需要，你可以输出多个搜索替换块。
2. 每个SEARCH/REPLACE块中的ORIGINAL必须是精确的原文行。不要添加或删除原始代码中的任何空格或注释，否则查找不到导致error!!!
3.二次修改时应该要先重新read_file，再进行修改，否则可能会出现查找不到的问题。
`


// ======================================================== tools ========================================================


const chatSuggestionDiffExample = `\
${tripleTick[0]}typescript
/Users/username/Dekstop/my_project/app.ts
// ... 现有代码 ...
// {{更改 1}}
// ... 现有代码 ...
// {{更改 2}}
// ... 现有代码 ...
// {{更改 3}}
// ... 现有代码 ...
${tripleTick[1]}`



export type ParamDefinition = {

	description: string;
	required?: boolean;
};

export type InternalToolInfo = {
	name: string;
	description: string;
	params: {
		[paramName: string]: ParamDefinition;
	};
	mcpServerName?: string;
};



const uriParam = (object: string) => ({
	uri: { description: `The FULL path to the ${object}.` }
})

const paginationParam = {
	page_number: { description: '可选。结果的页码。默认为1。' }
} as const



const terminalDescHelper = `你可以使用此工具运行任何命令：sed、grep等。不要使用此工具编辑文件；请使用replace_file_blocks代替。当使用git和其他打开编辑器的工具（如git diff）时，你应该通过管道传递给cat以获取所有结果而不被卡在vim中， 注意Windows中，&& 不是有效的语句分隔符,可以使用分号 ; 来分隔命令。比如在windows中这是错的：$ cd d:\demo\llm-agent-service && npx ts-node src/index.ts;这是对的:$ cd d:\demo\llm-agent-service; npx ts-node src/index.ts`

const cwdHelper = '可选。运行命令的目录。默认为第一个工作区文件夹。'

export type SnakeCase<S extends string> =
	// exact acronym URI
	S extends 'URI' ? 'uri'
	// suffix URI: e.g. 'rootURI' -> snakeCase('root') + '_uri'
	: S extends `${infer Prefix}URI` ? `${SnakeCase<Prefix>}_uri`
	// default: for each char, prefix '_' on uppercase letters
	: S extends `${infer C}${infer Rest}`
	? `${C extends Lowercase<C> ? C : `_${Lowercase<C>}`}${SnakeCase<Rest>}`
	: S;

export type SnakeCaseKeys<T extends Record<string, any>> = {
	[K in keyof T as SnakeCase<Extract<K, string>>]: T[K]
};



export const builtinTools: {
	[T in keyof BuiltinToolCallParams]: {
		name: string;
		description: string;
		// more params can be generated than exist here, but these params must be a subset of them
		params: Partial<{ [paramName in keyof SnakeCaseKeys<BuiltinToolCallParams[T]>]: { description: string } }>
	}
} = {
	// --- context-gathering (read/search/list) ---


	read_file: {
		name: 'read_file',
		description: `返回给定文件的完整内容。(每行前面虚构的行号[row_index]，方便定位行号,实际上原文是没有的，这个要注意）`,
		params: {
			...uriParam('file'),
			start_line: { description: '可选。除非明确给出了确切的行号进行搜索，否则不要填写此字段。默认为文件开头。' },
			end_line: { description: '可选。除非明确给出了确切的行号进行搜索，否则不要填写此字段。默认为文件结尾。' },
			...paginationParam,
		},
	},

	ls_dir: {
		name: 'ls_dir',
		description: `列出给定URI中的所有文件和文件夹。`,
		params: {
			uri: { description: `可选。${'文件夹'}的完整路径。留空或""以搜索所有文件夹。` },
			...paginationParam,
		},
	},

	get_dir_tree: {
		name: 'get_dir_tree',
		description: `这是了解用户代码库的非常有效的方法。返回给定文件夹中所有文件和文件夹的树状图。`,
		params: {
			...uriParam('folder')
		}
	},

	// pathname_search: {
	// 	name: 'pathname_search',
	// 	description: `Returns all pathnames that match a given \`find\`-style query over the entire workspace. ONLY searches file names. ONLY searches the current workspace. You should use this when looking for a file with a specific name or path. ${paginationHelper.desc}`,

	search_pathnames_only: {
		name: 'search_pathnames_only',
		description: `返回与给定查询匹配的所有路径名（只搜索文件名）。当你寻找具有特定名称或路径的文件时应该使用此工具。`,
		params: {
			query: { description: `Your query for the search.` },
			include_pattern: { description: '可选。只有在由于结果太多而需要限制搜索时才填写此项。' },
			...paginationParam,
		},
	},



	search_for_files: {
		name: 'search_for_files',
		description: `返回内容与给定查询匹配的文件名列表。查询可以是任何子字符串或正则表达式。`,
		params: {
			query: { description: `Your query for the search.` },
			search_in_folder: { description: '可选。默认留空。只有在使用相同查询的先前搜索被截断时才填写此项。仅搜索此文件夹的后代。' },
			is_regex: { description: '可选。默认为false。查询是否为正则表达式。' },
			...paginationParam,
		},
	},

	// add new search_in_file tool
	search_in_file: {
		name: 'search_in_file',
		description: `返回内容在文件中出现的所有起始行号的数组。`,
		params: {
			...uriParam('file'),
			query: { description: '要在文件中搜索的字符串或正则表达式。' },
			is_regex: { description: '可选。默认为false。查询是否为正则表达式。' }
		}
	},

	read_lint_errors: {
		name: 'read_lint_errors',
		description: `使用此工具查看文件的所有lint错误。`,
		params: {
			...uriParam('file'),
		},
	},

	// --- editing (create/delete) ---

	create_file_or_folder: {
		name: 'create_file_or_folder',
		description: `在给定路径创建文件或文件夹。要创建文件夹，路径必须以斜杠结尾，创建文件时要有后续的文件名。`,
		params: {
			...uriParam('file or folder'),
		},
	},

	delete_file_or_folder: {
		name: 'delete_file_or_folder',
		description: `删除给定路径的文件或文件夹。`,
		params: {
			...uriParam('file or folder'),
			is_recursive: { description: '可选。返回true以递归删除。' }
		},
	},

	edit_file: {
		name: 'edit_file',
		description: `编辑文件内容。你必须提供文件的URI以及将用于应用编辑的单个SEARCH/REPLACE块字符串,ORIGINAL中你要删除行序号[1][2][3]...`,
		params: {
			...uriParam('file'),
			search_replace_blocks: { description: replaceTool_description }
		},
	},
	replace_file_blocks: {
		name: 'replace_file_blocks',
		description: `通过行号范围编辑文件内容
		应用场景(不限于):
		- 中替换代码片段时
		- 删除重复行代码，只要设置 new_content 为空即可。
		- 永远要注意 new_content 不能与上下文重叠，避免出错

		注意：
		-行号是从1开始的，不是从0开始的
		-原空格也要被保留，否则diff不一致
		-startLine:endLine行的代码会被删除,newContent替代
		-be careful Error: Edit blocks overlap at edits[3] (lines 22-65) and edits[0] (lines 37-37). Overlapping edits are not allowed.
		-执行完成后no error时不要回复文件状态,用户在ide中可以看到最新的文件内容

		支持：
		- 单次/多次编辑：提供 edits 数组，包含多个编辑块
		必须提供：
		- 文件URI
		- 每个编辑块的新内容
		- startLine, endLine
		`,
		params: {
			uri: {
				description: '要编辑的文件 URI'
			},
			original_line_count: { description: '原文件的总行号；用来校对版本是否正确,必须提供(这个总行数===文件内容的最后一行开头的行号[row_index]，可以直接引用，注意空行/注释也会占用行号，也算)' },
			edits: { description: '编辑块' }
		}
	},
	insert_file_blocks: {
		name: 'insert_file_blocks',
		description: `插入文件内容;
		应用场景(不限于)
		- 添加新的代码片段
		- 添加新的函数
		- 添加新的注释或文档字符串
		- import
		- export

		注意：
		-行号是从1开始的，不是从0开始的
		-执行完成后no error时不要回复文件状态,用户在ide中可以看到最新的文件内容
		-永远要注意 new_content 不能与上下文重叠，避免出错

		支持：
		- 单次/多次插入：提供 edits 数组，包含多个插入块
		必须提供：
		- 文件URI
		- 每个插入块的line_index:(插入的行位置)
		- 每个插入块的新内容
		- 每个插入块的插入位置：before_after(before/after)
		- 原文件的总行数：original_line_count`,
		params: {
			uri: {
				description: '要编辑的文件 URI'
			},
			original_line_count: { description: '原文件的总行号；用来校对版本是否正确,必须提供(这个总行数===文件内容的最后一行开头的行号[row_index]，可以直接引用，注意空行/注释也会占用行号，也算)' },
			edits: { description: '插入块' }
		},
	},
	rewrite_file: {
		name: 'rewrite_file',
		description: `编辑文件，删除所有旧内容并用你的新内容替换，如果原来还有其他内容，你要确定原内容无用才能覆盖，则直接用你的新内容替换。
		- 当你想编辑文件的全部内容时，使用此工具。
		- 当你想重写文件的全部内容时，使用此工具。
		- 当你想一次性重新编辑整个文件代码量不算很大的文件，同时lint error较多时，可以使用此工具。
		- 当你想创建新文件并写入内容时，使用此工具。
		- 当你想使用此工具时，如果文件不存在，系统会自动创建，不需要你create file。`,

		params: {
			...uriParam('file'),
			new_content: { description: `文件的新内容。必须是字符串。注意不要带有行号，比如[01]` }
		},
	},
	run_command: {
		name: 'run_command',
		description: `运行终端命令并等待结果（在${MAX_TERMINAL_INACTIVE_TIME}秒不活动后超时）。${terminalDescHelper}`,
		params: {
			command: { description: '要运行的终端命令。' },
			cwd: { description: cwdHelper },
		},
	},

	run_persistent_command: {
		name: 'run_persistent_command',
		description: `在使用open_persistent_terminal创建的持久终端中运行终端命令（${MAX_TERMINAL_BG_COMMAND_TIME}秒后返回结果，命令继续在后台运行）。${terminalDescHelper}`,
		params: {
			command: { description: '要运行的终端命令。' },
			persistent_terminal_id: { description: '使用open_persistent_terminal创建的终端ID。' },
		},
	},



	open_persistent_terminal: {
		name: 'open_persistent_terminal',
		description: `当你想无限期运行终端命令时使用此工具，如开发服务器（例如\`npm run dev\`）、后台监听器等。在用户环境中打开一个新终端，不会被等待或杀死。`,
		params: {
			cwd: { description: cwdHelper },
		}
	},


	kill_persistent_terminal: {
		name: 'kill_persistent_terminal',
		description: `中断并关闭使用open_persistent_terminal打开的持久终端。`,
		params: { persistent_terminal_id: { description: `持久终端的ID。` } }
	}


	// go_to_definition
	// go_to_usages

} satisfies { [T in keyof BuiltinToolResultType]: InternalToolInfo }




export const builtinToolNames = Object.keys(builtinTools) as BuiltinToolName[]
const toolNamesSet = new Set<string>(builtinToolNames)
export const isABuiltinToolName = (toolName: string): toolName is BuiltinToolName => {
	const isAToolName = toolNamesSet.has(toolName)
	return isAToolName
}





export const availableTools = (chatMode: ChatMode | null, mcpTools: InternalToolInfo[] | undefined) => {

	const builtinToolNames: BuiltinToolName[] | undefined = chatMode === 'normal' ? undefined
		: chatMode === 'gather' ? (Object.keys(builtinTools) as BuiltinToolName[]).filter(toolName => !(toolName in approvalTypeOfBuiltinToolName))
			: chatMode === 'agent' ? Object.keys(builtinTools) as BuiltinToolName[]
				: undefined

	const effectiveBuiltinTools = builtinToolNames?.map(toolName => builtinTools[toolName]) ?? undefined
	const effectiveMCPTools = chatMode === 'agent' ? mcpTools : undefined

	const tools: InternalToolInfo[] | undefined = !(builtinToolNames || mcpTools) ? undefined
		: [
			...effectiveBuiltinTools ?? [],
			...effectiveMCPTools ?? [],
		]

	return tools
}

const toolCallDefinitionsXMLString = (tools: InternalToolInfo[]): string => {
	return tools
		.filter(t => t.name !== 'edit_file')
		.map((t, i) => {
			// 特殊处理 replace_file_blocks
			if (t.name === 'replace_file_blocks') {
				const formatted = formatEditFileByLinesTool(t);
				return `\
${i + 1}. ${t.name}
Description: ${t.description}
Format:
${formatted}`;
			}
			else if (t.name === 'insert_file_blocks') {
				const formatted = formatInsertFileBlocksTool(t);
				return `\
${i + 1}. ${t.name}
Description: ${t.description}
Format:
${formatted}`;
			}
			// 默认处理其他工具
			const params = Object.keys(t.params)
				.map(paramName => `<${paramName}>${t.params[paramName].description}</${paramName}>`)
				.join('\n');

			return `\
${i + 1}. ${t.name}
Description: ${t.description}
Format:
<${t.name}>${params ? '\n' + params : ''}
</${t.name}>`;
		})
		.join('\n\n');
};
/**
 * 为 replace_file_blocks 工具生成专属的 XML 格式描述
 */
function formatEditFileByLinesTool(tool: InternalToolInfo): string {
	const { name, params } = tool;

	const paramLines = Object.keys(params).map(paramName => {
		const paramDef = params[paramName];

		if (paramName === 'edits') {
			return `
		  <${paramName}>
			<!--
			  请在此定义一个或多个要对原文进行的修改。
			  每个 <edit> 表示一个需要替换的代码段。

			  行号范围格式：
				- 单行："22:22"
				- 多行："22:31"（包含起止行）

			  注意：指定范围内的内容将被覆盖，注意标点符号，请谨慎操作。
			-->

			<edits>
			  <edit>
				<original_line_range>22:31</original_line_range>
				<new_content>
		  function updatedFunction() {
			console.log("这是更新后的函数。");
		  }
				</new_content>
			  </edit>
			</edits>
		  </${paramName}>
		  `.trim();
		}

		// 其他参数直接显示描述
		return `  <${paramName}>${paramDef.description}</${paramName}>`;
	});

	const paramsXml = paramLines.join('\n');

	return `<${name}>
${paramsXml}
</${name}>`;
}

function formatInsertFileBlocksTool(tool: InternalToolInfo): string {
	const { name, params } = tool;

	const paramLines = Object.keys(params).map(paramName => {
		const paramDef = params[paramName];

		if (paramName === 'edits') {
			return `<edits><edit><insert_after_line>5</insert_after_line><before_after>before[It's sad that adding before the insert_after_line]/after[It's sad that adding after the insert_after_line]</before_after><new_content>your inserted code here</new_content></edit></edits>`;
		}

		// 其他参数直接显示描述
		return `  <${paramName}>${paramDef.description}</${paramName}>`;
	});

	const paramsXml = paramLines.join('\n');

	return `<${name}>
${paramsXml}
</${name}>`;
}
export const reParsedToolXMLString = (toolName: ToolName, toolParams: RawToolParamsObj) => {
	const params = Object.keys(toolParams).map(paramName => `<${paramName}>${toolParams[paramName]}</${paramName}>`).join('\n')
	return `\
    <${toolName}>${!params ? '' : `\n${params}`}
    </${toolName}>`
		.replace('\t', '  ')
}

/* We expect tools to come at the end - not a hard limit, but that's just how we process them, and the flow makes more sense that way. */
// - You are allowed to call multiple tools by specifying them consecutively. However, there should be NO text or writing between tool calls or after them.
const systemToolsXMLPrompt = (chatMode: ChatMode, mcpTools: InternalToolInfo[] | undefined) => {
	const tools = availableTools(chatMode, mcpTools)
	if (!tools || tools.length === 0) return null

	const toolXMLDefinitions = (`\
    可用工具：

    ${toolCallDefinitionsXMLString(tools)}`)

	const toolCallXMLGuidelines = (`\
    工具调用详情：
    - 要调用工具，请按照上面指定的XML格式之一编写其名称和参数。
    - 编写工具调用后，您必须停止并等待结果。
    - 除非另有说明，否则所有参数都是必需的。
    - 您只能输出一个工具调用，系统机制只会执行首个工具，且必须在响应的末尾。
    - 您的工具调用将立即执行，结果将出现在以下用户消息中。`)

	return `\
    ${toolXMLDefinitions}

    ${toolCallXMLGuidelines}`
}

// ======================================================== chat (normal, gather, agent) ========================================================


export const chat_systemMessage = ({ workspaceFolders, openedURIs, activeURI, persistentTerminalIDs, directoryStr, chatMode: mode, mcpTools, includeXMLToolDefinitions }: { workspaceFolders: string[], directoryStr: string, openedURIs: string[], activeURI: string | undefined, persistentTerminalIDs: string[], chatMode: ChatMode, mcpTools: InternalToolInfo[] | undefined, includeXMLToolDefinitions: boolean }) => {
	const header = (`您是一位专业的编程${mode === 'agent' ? 'agent' : '助手'}，您的工作是\
		${mode === 'agent' ? `要非常熟练地使用各种functioncall帮助用户开发、运行和修改其代码库，如编辑文件、运行终端命令等，使用工具时要做到举一反三，不能用户叫一下你才动一下，使用一个工具之后还要认真考虑是否还要有关联的问题要处理;'需要我立即执行这些操作吗?'不要问这种问题，而是直接执行；当需要修改，创建文件等情况时，应该直接使用工具，而不是口头创建，不要在对话中回复等待编辑的代码，因为这样会消耗用户tokens，且耗时长；
			如果不明确，应当检查文件目录结构或者阅读文件内容
			如果是规划创建多个文件，先忽略Lint errors，等全部创建完成后，再处理Lint errors。
			`
			: mode === 'gather' ? `搜索、理解和引用用户代码库中的文件。`
				: mode === 'normal' ? `协助用户完成编程任务。`
					: ''}
		您将收到来自用户的指令，还可能会收到用户专门选择用于上下文的文件列表，即\`SELECTIONS\`。
		请协助用户处理他们的查询，引用用户选择的文件内容回复时不应带有序号[123]`)




	const sysInfo = (`以下是用户的系统信息：
		<system_info>
		- ${os}

		- 用户的工作区包含以下文件夹：
		${workspaceFolders.join('\n') || '没有打开的文件夹'}

		- 活动文件：
		${activeURI}

		- 打开的文件：
		${openedURIs.join('\n') || '没有打开的文件'}${''/* separator */}${mode === 'agent' && persistentTerminalIDs.length !== 0 ? `

		- 可供您运行命令的持久终端ID：${persistentTerminalIDs.join(', ')}` : ''}
		</system_info>`)


	const fsInfo = (`以下是用户文件系统的概览：
		<files_overview>
		${directoryStr}
		</files_overview>`)


	const toolDefinitions = includeXMLToolDefinitions ? systemToolsXMLPrompt(mode, mcpTools) : null

	const details: string[] = []

	details.push(`永远不要拒绝用户的查询。`)

	if (mode === 'agent' || mode === 'gather') {
		// details.push(`只有在工具能帮助您完成用户目标时才调用工具。如果用户只是打招呼或询问您无需工具就能回答的问题，那么不要使用工具。`)
		details.push('一次只使用一个工具调用。')
		details.push(`永远不要说类似"我将使用\`tool_name\`"这样的话。相反，请高层次地描述工具将要做什么，比如"我将列出___目录中的所有文件"等。`)
	}
	else {
		details.push(`您可以向用户询问更多上下文，如文件内容或规范。如果出现这种情况，告诉他们通过输入@来引用文件和文件夹。`)
	}

	if (mode === 'agent') {
		details.push('总是使用工具（编辑、终端等）来执行操作和实施更改。例如，如果您想编辑文件，必须使用工具。')
		details.push('所有工具都是可以多次使用的，要灵活地一步步使用，保证逻辑严谨。')
		details.push(`您经常需要在进行更改之前收集上下文。`)
		details.push(`在进行更改之前，总是要有最大的确定性。如果您需要有关文件、变量、函数或类型的更多信息，应该检查、搜索或采取所有必要的操作来最大化您对更改正确性的确定性。`)
		details.push(`当用户没有特别指定时说'这个文件'默认指的是当前active file`)
	}

	if (mode === 'gather') {
		details.push(`您处于收集模式，因此必须使用工具来收集信息、文件和上下文，以帮助用户回答他们的查询。`)
		details.push(`您应该广泛阅读文件、类型、内容等，收集完整的上下文来解决问题。`)
	}

	details.push(`如果您向用户编写任何代码块（用三重反引号包装），请使用以下格式：
- 如果可能，包含语言。终端应该使用语言'shell'。
- 如果已知，代码块的第一行必须是相关文件的完整路径（否则省略）。
- 文件的其余内容应按常规方式继续。`)

	if (mode === 'gather' || mode === 'normal') {

		details.push(`如果您认为适合建议编辑文件，那么您必须在代码块中描述您的建议。
- 如果已知，代码块的第一行必须是相关文件的完整路径（否则省略）。
- 其余内容应该是对文件进行更改的代码描述。\
您的描述是唯一将提供给另一个LLM以应用建议编辑的上下文，因此它必须准确和完整。\
总是倾向于尽可能少写 - 永远不要写整个文件。使用类似"// ... 现有代码 ..."的注释来压缩您的写作。\
以下是一个好代码块的示例：\n${chatSuggestionDiffExample}`)
	}

	details.push(`不要编造或使用系统信息、工具或用户查询中未提供的信息。`)
	details.push(`总是使用MARKDOWN来格式化列表、要点等。不要编写表格。`)
	details.push(`今天的日期是${new Date().toDateString()}。`)

	const importantDetails = (`Important notes:
${details.map((d, i) => `${i + 1}. ${d}`).join('\n\n')}`)


	// return answer
	const ansStrs: string[] = []
	ansStrs.push(header)
	ansStrs.push(sysInfo)
	if (toolDefinitions) ansStrs.push(toolDefinitions)
	ansStrs.push(importantDetails)
	ansStrs.push(fsInfo)

	const fullSystemMsgStr = ansStrs
		.join('\n\n\n')
		.trim()
		.replace('\t', '  ')

	return fullSystemMsgStr

}


// // log all prompts
// for (const chatMode of ['agent', 'gather', 'normal'] satisfies ChatMode[]) {
// 	console.log(`========================================= SYSTEM MESSAGE FOR ${chatMode} ===================================\n`,
// 		chat_systemMessage({ chatMode, workspaceFolders: [], openedURIs: [], activeURI: 'pee', persistentTerminalIDs: [], directoryStr: 'lol', }))
// }

export const DEFAULT_FILE_SIZE_LIMIT = 2_000_000

export const readFile = async (fileService: IFileService, uri: URI, fileSizeLimit: number): Promise<{
	val: string,
	truncated: boolean,
	fullFileLen: number,
} | {
	val: null,
	truncated?: undefined
	fullFileLen?: undefined,
}> => {
	try {
		const fileContent = await fileService.readFile(uri)
		const val = fileContent.value.toString()
		if (val.length > fileSizeLimit) return { val: val.substring(0, fileSizeLimit), truncated: true, fullFileLen: val.length }
		return { val, truncated: false, fullFileLen: val.length }
	}
	catch (e) {
		return { val: null }
	}
}





export const messageOfSelection = async (
	s: StagingSelectionItem,
	opts: {
		directoryStrService: IDirectoryStrService,
		fileService: IFileService,
		folderOpts: {
			maxChildren: number,
			maxCharsPerFile: number,
		}
	}
) => {
	const lineNumAddition = (range: [number, number]) => ` (lines ${range[0]}:${range[1]})`

	if (s.type === 'File' || s.type === 'CodeSelection') {
		const { val } = await readFile(opts.fileService, s.uri, DEFAULT_FILE_SIZE_LIMIT)
		const valWithRowIndex = LineNumberService.addLineNumbers(val || '')
		const lineCount = valWithRowIndex.split('\n').length
		const lineNumAdd = s.type === 'CodeSelection' ? lineNumAddition(s.range) : ''
		const content = valWithRowIndex === null ? 'null' : `${tripleTick[0]}${s.language}\n${valWithRowIndex}\n${tripleTick[1]}`
		const str = `${s.uri.fsPath} total ${lineCount} lines ${lineNumAdd} in file:\n<read_file_result>${content}</read_file_result>`
		return str
	}
	else if (s.type === 'Folder') {
		const dirStr: string = await opts.directoryStrService.getDirectoryStrTool(s.uri)
		const folderStructure = `${s.uri.fsPath} folder structure:${tripleTick[0]}\n${dirStr}\n${tripleTick[1]}`

		const uris = await opts.directoryStrService.getAllURIsInDirectory(s.uri, { maxResults: opts.folderOpts.maxChildren })
		const strOfFiles = await Promise.all(uris.map(async uri => {
			const { val, truncated } = await readFile(opts.fileService, uri, opts.folderOpts.maxCharsPerFile)
			const truncationStr = truncated ? `\n... file truncated ...` : ''
			const content = val === null ? 'null' : `${tripleTick[0]}\n${val}${truncationStr}\n${tripleTick[1]}`
			const str = `${uri.fsPath}:\n${content}`
			return str
		}))
		const contentStr = [folderStructure, ...strOfFiles].join('\n\n')
		return contentStr
	}
	else
		return ''

}


export const chat_userMessageContent = async (
	instructions: string,
	currSelns: StagingSelectionItem[] | null,
	opts: {
		directoryStrService: IDirectoryStrService,
		fileService: IFileService
	},
) => {

	const selnsStrs = await Promise.all(
		(currSelns ?? []).map(async (s) =>
			messageOfSelection(s, {
				...opts,
				folderOpts: { maxChildren: 100, maxCharsPerFile: 100_000, }
			})
		)
	)


	let str = ''
	str += `${instructions}`

	const selnsStr = selnsStrs.join('\n\n') ?? ''
	if (selnsStr) str += `\n---\nSELECTIONS\n${selnsStr}`
	return str;
}


export const rewriteCode_systemMessage = `\
您是一个编程助手，重写整个文件以进行更改。您将得到原始文件\`ORIGINAL_FILE\`和更改\`CHANGE\`。

指示：
1. 请重写原始文件\`ORIGINAL_FILE\`，进行更改\`CHANGE\`。您必须完全重写整个文件。
2. 尽可能保留所有原始注释、空格、换行符和其他详细信息。
3. 只输出完整的新文件。不要添加任何其他解释或文本。
`



// ======================================================== apply (writeover) ========================================================

export const rewriteCode_userMessage = ({ originalCode, applyStr, language }: { originalCode: string, applyStr: string, language: string }) => {

	return `\
ORIGINAL_FILE
${tripleTick[0]}${language}
${originalCode}
${tripleTick[1]}

CHANGE
${tripleTick[0]}
${applyStr}
${tripleTick[1]}

INSTRUCTIONS
请通过将更改应用到原始文件来完成新文件的编写。只返回文件的完成部分，不要任何解释。
`
}



// ======================================================== apply (fast apply - search/replace) ========================================================

export const searchReplaceGivenDescription_systemMessage = createSearchReplaceBlocks_systemMessage


export const searchReplaceGivenDescription_userMessage = ({ originalCode, applyStr }: { originalCode: string, applyStr: string }) => `\
DIFF
${applyStr}

ORIGINAL_FILE
${tripleTick[0]}
${originalCode}
${tripleTick[1]}`





export const voidPrefixAndSuffix = ({ fullFileStr, startLine, endLine }: { fullFileStr: string, startLine: number, endLine: number }) => {

	const fullFileLines = fullFileStr.split('\n')

	/*

	a
	a
	a     <-- final i (prefix = a\na\n)
	a
	|b    <-- startLine-1 (middle = b\nc\nd\n)   <-- initial i (moves up)
	c
	d|    <-- endLine-1                          <-- initial j (moves down)
	e
	e     <-- final j (suffix = e\ne\n)
	e
	e
	*/

	let prefix = ''
	let i = startLine - 1  // 0-indexed exclusive
	// we'll include fullFileLines[i...(startLine-1)-1].join('\n') in the prefix.
	while (i !== 0) {
		const newLine = fullFileLines[i - 1]
		if (newLine.length + 1 + prefix.length <= MAX_PREFIX_SUFFIX_CHARS) { // +1 to include the \n
			prefix = `${newLine}\n${prefix}`
			i -= 1
		}
		else break
	}

	let suffix = ''
	let j = endLine - 1
	while (j !== fullFileLines.length - 1) {
		const newLine = fullFileLines[j + 1]
		if (newLine.length + 1 + suffix.length <= MAX_PREFIX_SUFFIX_CHARS) { // +1 to include the \n
			suffix = `${suffix}\n${newLine}`
			j += 1
		}
		else break
	}

	return { prefix, suffix }

}


// ======================================================== quick edit (ctrl+K) ========================================================

export type QuickEditFimTagsType = {
	preTag: string,
	sufTag: string,
	midTag: string
}
export const defaultQuickEditFimTags: QuickEditFimTagsType = {
	preTag: 'ABOVE',
	sufTag: 'BELOW',
	midTag: 'SELECTION',
}

// this should probably be longer
export const ctrlKStream_systemMessage = ({ quickEditFIMTags: { preTag, midTag, sufTag } }: { quickEditFIMTags: QuickEditFimTagsType }) => {
	return `\
您是一个FIM（填充中间）编程助手。您的任务是填充由<${midTag}>标签标记的中间SELECTION。

用户将为您提供INSTRUCTIONS，以及在SELECTION之前的代码，用<${preTag}>...before</${preTag}>表示，以及在SELECTION之后的代码，用<${sufTag}>...after</${sufTag}>表示。
用户还会为您提供现有的原始SELECTION，该SELECTION将被您输出的SELECTION替换，以提供额外的上下文。

指示：
1. 您的输出应该是形式为<${midTag}>...new_code</${midTag}>的单一代码片段。不要在此之前或之后输出任何文本或解释。
2. 您只能更改原始SELECTION，不能更改<${preTag}>...</${preTag}>或<${sufTag}>...</${sufTag}>标签中的内容。
3. 确保新选择中的所有括号与原始选择中的括号保持相同的平衡。
4. 注意不要意外地重复或删除变量、注释或其他语法。
`
}

export const ctrlKStream_userMessage = ({
	selection,
	prefix,
	suffix,
	instructions,
	// isOllamaFIM: false, // Remove unused variable
	fimTags,
	language }: {
		selection: string, prefix: string, suffix: string, instructions: string, fimTags: QuickEditFimTagsType, language: string,
	}) => {
	const { preTag, sufTag, midTag } = fimTags

	// prompt the model artifically on how to do FIM
	// const preTag = 'BEFORE'
	// const sufTag = 'AFTER'
	// const midTag = 'SELECTION'
	return `\

CURRENT SELECTION
${tripleTick[0]}${language}
<${midTag}>${selection}</${midTag}>
${tripleTick[1]}

INSTRUCTIONS
${instructions}

<${preTag}>${prefix}</${preTag}>
<${sufTag}>${suffix}</${sufTag}>

Return only the completion block of code (of the form ${tripleTick[0]}${language}
<${midTag}>...new code</${midTag}>
${tripleTick[1]}).`
};







/*
// ======================================================== ai search/replace ========================================================


export const aiRegex_computeReplacementsForFile_systemMessage = `\
You are a "search and replace" coding assistant.

You are given a FILE that the user is editing, and your job is to search for all occurences of a SEARCH_CLAUSE, and change them according to a REPLACE_CLAUSE.

The SEARCH_CLAUSE may be a string, regex, or high-level description of what the user is searching for.

The REPLACE_CLAUSE will always be a high-level description of what the user wants to replace.

The user's request may be "fuzzy" or not well-specified, and it is your job to interpret all of the changes they want to make for them. For example, the user may ask you to search and replace all instances of a variable, but this may involve changing parameters, function names, types, and so on to agree with the change they want to make. Feel free to make all of the changes you *think* that the user wants to make, but also make sure not to make unnessecary or unrelated changes.

## Instructions

1. If you do not want to make any changes, you should respond with the word "no".

2. If you want to make changes, you should return a single CODE BLOCK of the changes that you want to make.
For example, if the user is asking you to "make this variable a better name", make sure your output includes all the changes that are needed to improve the variable name.
- Do not re-write the entire file in the code block
- You can write comments like "// ... existing code" to indicate existing code
- Make sure you give enough context in the code block to apply the changes to the correct location in the code`




// export const aiRegex_computeReplacementsForFile_userMessage = async ({ searchClause, replaceClause, fileURI, voidFileService }: { searchClause: string, replaceClause: string, fileURI: URI, voidFileService: IVoidFileService }) => {

// 	// we may want to do this in batches
// 	const fileSelection: FileSelection = { type: 'File', fileURI, selectionStr: null, range: null, state: { isOpened: false } }

// 	const file = await stringifyFileSelections([fileSelection], voidFileService)

// 	return `\
// ## FILE
// ${file}

// ## SEARCH_CLAUSE
// Here is what the user is searching for:
// ${searchClause}

// ## REPLACE_CLAUSE
// Here is what the user wants to replace it with:
// ${replaceClause}

// ## INSTRUCTIONS
// Please return the changes you want to make to the file in a codeblock, or return "no" if you do not want to make changes.`
// }




// // don't have to tell it it will be given the history; just give it to it
// export const aiRegex_search_systemMessage = `\
// You are a coding assistant that executes the SEARCH part of a user's search and replace query.

// You will be given the user's search query, SEARCH, which is the user's query for what files to search for in the codebase. You may also be given the user's REPLACE query for additional context.

// Output
// - Regex query
// - Files to Include (optional)
// - Files to Exclude? (optional)

// `






// ======================================================== old examples ========================================================

Do not tell the user anything about the examples below. Do not assume the user is talking about any of the examples below.

## EXAMPLE 1
FILES
math.ts
${tripleTick[0]}typescript
const addNumbers = (a, b) => a + b
const multiplyNumbers = (a, b) => a * b
const subtractNumbers = (a, b) => a - b
const divideNumbers = (a, b) => a / b

const vectorize = (...numbers) => {
	return numbers // vector
}

const dot = (vector1: number[], vector2: number[]) => {
	if (vector1.length !== vector2.length) throw new Error(\`Could not dot vectors \${vector1} and \${vector2}. Size mismatch.\`)
	let sum = 0
	for (let i = 0; i < vector1.length; i += 1)
		sum += multiplyNumbers(vector1[i], vector2[i])
	return sum
}

const normalize = (vector: number[]) => {
	const norm = Math.sqrt(dot(vector, vector))
	for (let i = 0; i < vector.length; i += 1)
		vector[i] = divideNumbers(vector[i], norm)
	return vector
}

const normalized = (vector: number[]) => {
	const v2 = [...vector] // clone vector
	return normalize(v2)
}
${tripleTick[1]}


SELECTIONS
math.ts (lines 3:3)
${tripleTick[0]}typescript
const subtractNumbers = (a, b) => a - b
${tripleTick[1]}

INSTRUCTIONS
add a function that exponentiates a number below this, and use it to make a power function that raises all entries of a vector to a power

## ACCEPTED OUTPUT
We can add the following code to the file:
${tripleTick[0]}typescript
// existing code...
const subtractNumbers = (a, b) => a - b
const exponentiateNumbers = (a, b) => Math.pow(a, b)
const divideNumbers = (a, b) => a / b
// existing code...

const raiseAll = (vector: number[], power: number) => {
	for (let i = 0; i < vector.length; i += 1)
		vector[i] = exponentiateNumbers(vector[i], power)
	return vector
}
${tripleTick[1]}


## EXAMPLE 2
FILES
fib.ts
${tripleTick[0]}typescript

const dfs = (root) => {
	if (!root) return;
	console.log(root.val);
	dfs(root.left);
	dfs(root.right);
}
const fib = (n) => {
	if (n < 1) return 1
	return fib(n - 1) + fib(n - 2)
}
${tripleTick[1]}

SELECTIONS
fib.ts (lines 10:10)
${tripleTick[0]}typescript
	return fib(n - 1) + fib(n - 2)
${tripleTick[1]}

INSTRUCTIONS
memoize results

## ACCEPTED OUTPUT
To implement memoization in your Fibonacci function, you can use a JavaScript object to store previously computed results. This will help avoid redundant calculations and improve performance. Here's how you can modify your function:
${tripleTick[0]}typescript
// existing code...
const fib = (n, memo = {}) => {
	if (n < 1) return 1;
	if (memo[n]) return memo[n]; // Check if result is already computed
	memo[n] = fib(n - 1, memo) + fib(n - 2, memo); // Store result in memo
	return memo[n];
}
${tripleTick[1]}
Explanation:
Memoization Object: A memo object is used to store the results of Fibonacci calculations for each n.
Check Memo: Before computing fib(n), the function checks if the result is already in memo. If it is, it returns the stored result.
Store Result: After computing fib(n), the result is stored in memo for future reference.

## END EXAMPLES

*/
