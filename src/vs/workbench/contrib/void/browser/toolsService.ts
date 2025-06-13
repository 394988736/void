import { CancellationToken } from '../../../../base/common/cancellation.js'
import { URI } from '../../../../base/common/uri.js'
import { IFileService } from '../../../../platform/files/common/files.js'
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js'
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js'
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js'
import { QueryBuilder } from '../../../services/search/common/queryBuilder.js'
import { ISearchService } from '../../../services/search/common/search.js'
import { IEditCodeService } from './editCodeServiceInterface.js'
import { ITerminalToolService } from './terminalToolService.js'
import { LintErrorItem, BuiltinToolCallParams, BuiltinToolResultType, BuiltinToolName, EditByLinesItem, InsertFileBlocksItem } from '../common/toolsServiceTypes.js'

import { IVoidModelService } from '../common/voidModelService.js'
import { EndOfLinePreference } from '../../../../editor/common/model.js'
import { IVoidCommandBarService } from './voidCommandBarService.js'
import { computeDirectoryTree1Deep, IDirectoryStrService, stringifyDirectoryTree1Deep } from '../common/directoryStrService.js'
import { IMarkerService, MarkerSeverity } from '../../../../platform/markers/common/markers.js'
import { timeout } from '../../../../base/common/async.js'
import { RawToolParamsObj } from '../common/sendLLMMessageTypes.js'
import { MAX_CHILDREN_URIs_PAGE, MAX_FILE_CHARS_PAGE, MAX_TERMINAL_BG_COMMAND_TIME, MAX_TERMINAL_INACTIVE_TIME } from '../common/prompt/prompts.js'
import { IVoidSettingsService } from '../common/voidSettingsService.js'
import { generateUuid } from '../../../../base/common/uuid.js'
import { LineNumberService } from './helpers/LineNumberService.js'
import { parseRawEdits, unescapeXml, parseRawInsertFileBlocks } from './helpers/xmlHelper.js'


// tool use for AI
type ValidateBuiltinParams = { [T in BuiltinToolName]: (p: RawToolParamsObj) => BuiltinToolCallParams[T] }
type CallBuiltinTool = { [T in BuiltinToolName]: (p: BuiltinToolCallParams[T]) => Promise<{ result: BuiltinToolResultType[T] | Promise<BuiltinToolResultType[T]>, interruptTool?: () => void }> }
type BuiltinToolResultToString = { [T in BuiltinToolName]: (p: BuiltinToolCallParams[T], result: Awaited<BuiltinToolResultType[T]>) => string }


const isFalsy = (u: unknown) => {
	return !u || u === 'null' || u === 'undefined'
}

const validateStr = (argName: string, value: unknown) => {
	if (value === null) throw new Error(`Invalid LLM output: ${argName} was null.`)
	if (typeof value !== 'string') throw new Error(`Invalid LLM output format: ${argName} must be a string, but its type is "${typeof value}". Full value: ${JSON.stringify(value)}.`)
	return value
}


// We are NOT checking to make sure in workspace
const validateURI = (uriStr: unknown) => {
	if (uriStr === null) throw new Error(`Invalid LLM output: uri was null.`)
	if (typeof uriStr !== 'string') throw new Error(`Invalid LLM output format: Provided uri must be a string, but it's a(n) ${typeof uriStr}. Full value: ${JSON.stringify(uriStr)}.`)
	const uri = URI.file(uriStr)
	return uri
}

const validateOptionalURI = (uriStr: unknown) => {
	if (isFalsy(uriStr)) return null
	return validateURI(uriStr)
}

const validateOptionalStr = (argName: string, str: unknown) => {
	if (isFalsy(str)) return null
	return validateStr(argName, str)
}


const validatePageNum = (pageNumberUnknown: unknown) => {
	if (!pageNumberUnknown) return 1
	const parsedInt = Number.parseInt(pageNumberUnknown + '')
	if (!Number.isInteger(parsedInt)) throw new Error(`Page number was not an integer: "${pageNumberUnknown}".`)
	if (parsedInt < 1) throw new Error(`Invalid LLM output format: Specified page number must be 1 or greater: "${pageNumberUnknown}".`)
	return parsedInt
}

const validateNumber = (numStr: unknown, opts: { default: number | null }) => {
	if (typeof numStr === 'number')
		return numStr
	if (isFalsy(numStr)) return opts.default

	if (typeof numStr === 'string') {
		const parsedInt = Number.parseInt(numStr + '')
		if (!Number.isInteger(parsedInt)) return opts.default
		return parsedInt
	}

	return opts.default
}

const validateProposedTerminalId = (terminalIdUnknown: unknown) => {
	if (!terminalIdUnknown) throw new Error(`A value for terminalID must be specified, but the value was "${terminalIdUnknown}"`)
	const terminalId = terminalIdUnknown + ''
	return terminalId
}

const validateBoolean = (b: unknown, opts: { default: boolean }) => {
	if (typeof b === 'string') {
		if (b === 'true') return true
		if (b === 'false') return false
	}
	if (typeof b === 'boolean') {
		return b
	}
	return opts.default
}


const checkIfIsFolder = (uriStr: string) => {
	uriStr = uriStr.trim()
	if (uriStr.endsWith('/') || uriStr.endsWith('\\')) return true
	return false
}

export interface IToolsService {
	readonly _serviceBrand: undefined;
	validateParams: ValidateBuiltinParams;
	callTool: CallBuiltinTool;
	stringOfResult: BuiltinToolResultToString;
}

export const IToolsService = createDecorator<IToolsService>('ToolsService');

export class ToolsService implements IToolsService {

	readonly _serviceBrand: undefined;

	public validateParams: ValidateBuiltinParams;
	public callTool: CallBuiltinTool;
	public stringOfResult: BuiltinToolResultToString;

	constructor(
		@IFileService fileService: IFileService,
		@IWorkspaceContextService workspaceContextService: IWorkspaceContextService,
		@ISearchService searchService: ISearchService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IVoidModelService voidModelService: IVoidModelService,
		@IEditCodeService editCodeService: IEditCodeService,
		@ITerminalToolService private readonly terminalToolService: ITerminalToolService,
		@IVoidCommandBarService private readonly commandBarService: IVoidCommandBarService,
		@IDirectoryStrService private readonly directoryStrService: IDirectoryStrService,
		@IMarkerService private readonly markerService: IMarkerService,
		@IVoidSettingsService private readonly voidSettingsService: IVoidSettingsService,
	) {

		const queryBuilder = instantiationService.createInstance(QueryBuilder);

		this.validateParams = {
			read_file: (params: RawToolParamsObj) => {
				const { uri: uriStr, start_line: startLineUnknown, end_line: endLineUnknown, page_number: pageNumberUnknown } = params
				const uri = validateURI(uriStr)
				const pageNumber = validatePageNum(pageNumberUnknown)

				let startLine = validateNumber(startLineUnknown, { default: null })
				let endLine = validateNumber(endLineUnknown, { default: null })

				if (startLine !== null && startLine < 1) startLine = null
				if (endLine !== null && endLine < 1) endLine = null

				return { uri, startLine, endLine, pageNumber }
			},
			ls_dir: (params: RawToolParamsObj) => {
				const { uri: uriStr, page_number: pageNumberUnknown } = params

				const uri = validateURI(uriStr)
				const pageNumber = validatePageNum(pageNumberUnknown)
				return { uri, pageNumber }
			},
			get_dir_tree: (params: RawToolParamsObj) => {
				const { uri: uriStr, } = params
				const uri = validateURI(uriStr)
				return { uri }
			},
			search_pathnames_only: (params: RawToolParamsObj) => {
				const {
					query: queryUnknown,
					search_in_folder: includeUnknown,
					page_number: pageNumberUnknown
				} = params

				const queryStr = validateStr('query', queryUnknown)
				const pageNumber = validatePageNum(pageNumberUnknown)
				const includePattern = validateOptionalStr('include_pattern', includeUnknown)

				return { query: queryStr, includePattern, pageNumber }

			},
			search_for_files: (params: RawToolParamsObj) => {
				const {
					query: queryUnknown,
					search_in_folder: searchInFolderUnknown,
					is_regex: isRegexUnknown,
					page_number: pageNumberUnknown
				} = params
				const queryStr = validateStr('query', queryUnknown)
				const pageNumber = validatePageNum(pageNumberUnknown)
				const searchInFolder = validateOptionalURI(searchInFolderUnknown)
				const isRegex = validateBoolean(isRegexUnknown, { default: false })
				return {
					query: queryStr,
					isRegex,
					searchInFolder,
					pageNumber
				}
			},
			search_in_file: (params: RawToolParamsObj) => {
				const { uri: uriStr, query: queryUnknown, is_regex: isRegexUnknown } = params;
				const uri = validateURI(uriStr);
				const query = validateStr('query', queryUnknown);
				const isRegex = validateBoolean(isRegexUnknown, { default: false });
				return { uri, query, isRegex };
			},

			read_lint_errors: (params: RawToolParamsObj) => {
				const {
					uri: uriUnknown,
				} = params
				const uri = validateURI(uriUnknown)
				return { uri }
			},

			// ---

			create_file_or_folder: (params: RawToolParamsObj) => {
				const { uri: uriUnknown } = params
				const uri = validateURI(uriUnknown)
				const uriStr = validateStr('uri', uriUnknown)
				const isFolder = checkIfIsFolder(uriStr)
				return { uri, isFolder }
			},

			delete_file_or_folder: (params: RawToolParamsObj) => {
				const { uri: uriUnknown, is_recursive: isRecursiveUnknown } = params
				const uri = validateURI(uriUnknown)
				const isRecursive = validateBoolean(isRecursiveUnknown, { default: false })
				const uriStr = validateStr('uri', uriUnknown)
				const isFolder = checkIfIsFolder(uriStr)
				return { uri, isRecursive, isFolder }
			},

			rewrite_file: (params: RawToolParamsObj) => {
				const { uri: uriStr, new_content: newContentUnknown } = params
				const uri = validateURI(uriStr)
				let newContent = validateStr('newContent', newContentUnknown)
				newContent = unescapeXml(newContent)
				return { uri, newContent }
			},

			edit_file: (params: RawToolParamsObj) => {
				const { uri: uriStr, search_replace_blocks: searchReplaceBlocksUnknown } = params
				const uri = validateURI(uriStr)
				const searchReplaceBlocks = validateStr('searchReplaceBlocks', searchReplaceBlocksUnknown)
				return { uri, searchReplaceBlocks }
			},

			replace_file_blocks: (params: RawToolParamsObj) => {
				const { uri: uriStr, original_line_count: originalContentTotalLineCountUnknown } = params// new_content: newContentUnknown
				const uri = validateURI(uriStr)
				const originalContentTotalLineCount = validateNumber(originalContentTotalLineCountUnknown, { default: null }) || 0

				// 支持多个编辑块，每个块可以有 startLine/endLine
				const edits: Array<EditByLinesItem> = [];



				let rawEditsInput = params.edits as string | undefined;

				let rawEdits: Array<EditByLinesItem> = [];

				if (!rawEditsInput) {
					const rawEdit = params.edit as string | undefined;
					if (rawEdit) {
						rawEditsInput = `<edits>${rawEdit}</edits>`
					}

				}
				if (typeof rawEditsInput === 'string') {
					rawEdits = parseRawEdits(rawEditsInput); // 将 XML 字符串转为数组
				}

				if (rawEdits.length > 0) {
					for (const edit of rawEdits) {
						let nc = validateStr('newContent', edit.newContent || '');
						nc = unescapeXml(nc)
						edits.push({
							startLine: edit.startLine,
							endLine: edit.endLine,
							newContent: nc,
						});
					}
				} else {
					throw new Error(`No edits provided. full value: ${rawEditsInput}`);
				}
				return {
					uri,
					original_line_count: originalContentTotalLineCount,
					edits,
				}
			},

			insert_file_blocks: (params: RawToolParamsObj) => {
				const { uri: uriStr, original_line_count: originalContentTotalLineCountUnknown } = params// new_content: newContentUnknown
				const uri = validateURI(uriStr)
				const originalContentTotalLineCount = validateNumber(originalContentTotalLineCountUnknown, { default: null }) || 0

				// 支持多个插入块，每个块可以有 line_index
				const edits: Array<InsertFileBlocksItem> = []


				let rawInsertionsInput = params.edits as string | undefined;
				if (!rawInsertionsInput) {
					const rawInsertionInput = params.edit as string | undefined;
					if (rawInsertionInput) {
						rawInsertionsInput = `<edits>${rawInsertionInput}</edits>`
					}
				}
				let rawInsertions: Array<InsertFileBlocksItem> = [];

				if (typeof rawInsertionsInput === 'string') {
					rawInsertions = parseRawInsertFileBlocks(rawInsertionsInput); // 将 XML 字符串转为数组
				}

				if (rawInsertions.length > 0) {
					for (const edit of rawInsertions) {
						const sl = validateNumber(edit.line_index, { default: 0 });

						let nc = validateStr('new_content', edit.new_content);
						nc = unescapeXml(nc)
						edits.push({
							line_index: sl !== null && sl >= 1 ? sl : 1,
							before_after: edit.before_after,
							new_content: nc,
						});
					}
				} else {
					throw new Error(`No rawInsertions provided. full value: ${rawInsertionsInput}`);
				}
				return {
					uri,
					original_line_count: originalContentTotalLineCount,
					edits,
				}
			},
			// ---

			run_command: (params: RawToolParamsObj) => {
				const { command: commandUnknown, cwd: cwdUnknown } = params
				const command = validateStr('command', commandUnknown)
				const cwd = validateOptionalStr('cwd', cwdUnknown)
				const terminalId = generateUuid()
				return { command, cwd, terminalId }
			},
			run_persistent_command: (params: RawToolParamsObj) => {
				const { command: commandUnknown, persistent_terminal_id: persistentTerminalIdUnknown } = params;
				const command = validateStr('command', commandUnknown);
				const persistentTerminalId = validateProposedTerminalId(persistentTerminalIdUnknown)
				return { command, persistentTerminalId };
			},
			open_persistent_terminal: (params: RawToolParamsObj) => {
				const { cwd: cwdUnknown } = params;
				const cwd = validateOptionalStr('cwd', cwdUnknown)
				// No parameters needed; will open a new background terminal
				return { cwd };
			},
			kill_persistent_terminal: (params: RawToolParamsObj) => {
				const { persistent_terminal_id: terminalIdUnknown } = params;
				const persistentTerminalId = validateProposedTerminalId(terminalIdUnknown);
				return { persistentTerminalId };
			},

		}


		this.callTool = {
			read_file: async ({ uri, startLine, endLine, pageNumber }) => {
				await voidModelService.initializeModel(uri)
				const { model } = await voidModelService.getModelSafe(uri)
				if (model === null) { throw new Error(`No contents; File does not exist.`) }
				let startLineNumber = 1
				let contents: string
				if (startLine === null && endLine === null) {
					contents = model.getValue(EndOfLinePreference.LF)
				}
				else {
					startLineNumber = startLine === null ? 1 : startLine
					const endLineNumber = endLine === null ? model.getLineCount() : endLine
					contents = model.getValueInRange({ startLineNumber, startColumn: 1, endLineNumber, endColumn: Number.MAX_SAFE_INTEGER }, EndOfLinePreference.LF)
				}

				const totalNumLines = model.getLineCount()

				const fromIdx = MAX_FILE_CHARS_PAGE * (pageNumber - 1)
				const toIdx = MAX_FILE_CHARS_PAGE * pageNumber - 1
				let fileContents = contents.slice(fromIdx, toIdx + 1) // paginate

				// Add line numbers with smart padding based on total lines
				fileContents = LineNumberService.addLineNumbers(fileContents, {
					padding: totalNumLines.toString().length,
					startAt: startLineNumber + fromIdx
				});
				const hasNextPage = (contents.length - 1) - toIdx >= 1
				const totalFileLen = contents.length
				return { result: { fileContents, totalFileLen, hasNextPage, original_line_count: totalNumLines } }
			},

			ls_dir: async ({ uri, pageNumber }) => {
				const dirResult = await computeDirectoryTree1Deep(fileService, uri, pageNumber)
				return { result: dirResult }
			},

			get_dir_tree: async ({ uri }) => {
				const str = await this.directoryStrService.getDirectoryStrTool(uri)
				return { result: { str } }
			},

			search_pathnames_only: async ({ query: queryStr, includePattern, pageNumber }) => {

				const query = queryBuilder.file(workspaceContextService.getWorkspace().folders.map(f => f.uri), {
					filePattern: queryStr,
					includePattern: includePattern ?? undefined,
					sortByScore: true, // makes results 10x better
				})
				const data = await searchService.fileSearch(query, CancellationToken.None)

				const fromIdx = MAX_CHILDREN_URIs_PAGE * (pageNumber - 1)
				const toIdx = MAX_CHILDREN_URIs_PAGE * pageNumber - 1
				const uris = data.results
					.slice(fromIdx, toIdx + 1) // paginate
					.map(({ resource, results }) => resource)

				const hasNextPage = (data.results.length - 1) - toIdx >= 1
				return { result: { uris, hasNextPage } }
			},

			search_for_files: async ({ query: queryStr, isRegex, searchInFolder, pageNumber }) => {
				const searchFolders = searchInFolder === null ?
					workspaceContextService.getWorkspace().folders.map(f => f.uri)
					: [searchInFolder]

				const query = queryBuilder.text({
					pattern: queryStr,
					isRegExp: isRegex,
				}, searchFolders)

				const data = await searchService.textSearch(query, CancellationToken.None)

				const fromIdx = MAX_CHILDREN_URIs_PAGE * (pageNumber - 1)
				const toIdx = MAX_CHILDREN_URIs_PAGE * pageNumber - 1
				const uris = data.results
					.slice(fromIdx, toIdx + 1) // paginate
					.map(({ resource, results }) => resource)

				const hasNextPage = (data.results.length - 1) - toIdx >= 1
				return { result: { queryStr, uris, hasNextPage } }
			},
			search_in_file: async ({ uri, query, isRegex }) => {
				await voidModelService.initializeModel(uri);
				const { model } = await voidModelService.getModelSafe(uri);
				if (model === null) { throw new Error(`No contents; File does not exist.`); }
				const contents = model.getValue(EndOfLinePreference.LF);
				const contentOfLine = contents.split('\n');
				const totalLines = contentOfLine.length;
				const regex = isRegex ? new RegExp(query) : null;
				const lines: number[] = []
				for (let i = 0; i < totalLines; i++) {
					const line = contentOfLine[i];
					if ((isRegex && regex!.test(line)) || (!isRegex && line.includes(query))) {
						const matchLine = i + 1;
						lines.push(matchLine);
					}
				}
				return { result: { lines } };
			},

			read_lint_errors: async ({ uri }) => {
				await timeout(1000)
				const { lintErrors } = this._getLintErrors(uri)
				return { result: { lintErrors } }
			},

			// ---

			create_file_or_folder: async ({ uri, isFolder }) => {
				if (isFolder)
					await fileService.createFolder(uri)
				else {
					await fileService.createFile(uri)
				}
				return { result: {} }
			},

			delete_file_or_folder: async ({ uri, isRecursive }) => {
				await fileService.del(uri, { recursive: isRecursive })
				return { result: {} }
			},

			rewrite_file: async ({ uri, newContent }) => {
				await voidModelService.initializeModel(uri)
				if (this.commandBarService.getStreamState(uri) === 'streaming') {
					throw new Error(`Another LLM is currently making changes to this file. Please stop streaming for now and ask the user to resume later.`)
				}
				await editCodeService.callBeforeApplyOrEdit(uri)
				const exists = await fileService.exists(uri)
				if (!exists) {
					await fileService.createFile(uri)
				}
				editCodeService.instantlyRewriteFile({ uri, newContent })
				// at end, get lint errors
				const resultPromise = Promise.resolve().then(async () => {
					await timeout(2000)
					const { lintErrors } = this._getLintErrors(uri)
					const result = (await this.callTool['read_file']({ uri, startLine: null, endLine: null, pageNumber: 1 }) as { result: { fileContents: string; totalFileLen: number; original_line_count: number; hasNextPage: boolean; }, interruptTool: () => void }).result
					return { lintErrors, file_content_applied: result.fileContents, original_line_count: `${result.original_line_count}` }
				})
				return { result: resultPromise }
			},

			edit_file: async ({ uri, searchReplaceBlocks }) => {
				await voidModelService.initializeModel(uri)
				if (this.commandBarService.getStreamState(uri) === 'streaming') {
					throw new Error(`Another LLM is currently making changes to this file. Please stop streaming for now and ask the user to resume later.`)
				}
				await editCodeService.callBeforeApplyOrEdit(uri)
				const _block = LineNumberService.removeFixedLineNumbers(searchReplaceBlocks)
				editCodeService.instantlyApplySearchReplaceBlocks({ uri, searchReplaceBlocks: _block })

				// at end, get lint errors
				const lintErrorsPromise = Promise.resolve().then(async () => {
					await timeout(2000)
					const { lintErrors } = this._getLintErrors(uri)
					return { lintErrors }
				})

				return { result: lintErrorsPromise }
			},
			replace_file_blocks: async ({ uri, original_line_count, edits }) => {
				// 初始化模型
				await voidModelService.initializeModel(uri)
				const { model } = await voidModelService.getModelSafe(uri)
				if (model === null) {
					throw new Error(`File does not exist or could not be loaded.`)
				}
				const lineCount = model.getLineCount()
				if (original_line_count !== lineCount) {
					throw new Error(`File content has been changed. Please refresh the file and try again.current line count:${lineCount},your file version line count:${original_line_count}`)
				}

				// 检查是否有其他流式操作正在进行
				if (this.commandBarService.getStreamState(uri) === 'streaming') {
					throw new Error(`Another LLM is currently making changes to this file. Please stop streaming for now and ask the user to resume later.`)
				}

				let originalContent = model.getValue(EndOfLinePreference.LF)
				let originalContentWithRowIndex = LineNumberService.addLineNumbers(originalContent)
				let beingApplyContentWithRowIndex = originalContentWithRowIndex
				// 遍历所有编辑项并应用
				for (const edit of edits) {
					const { startLine, endLine, newContent } = edit

					// 确保行号有效
					const safeStartLine = typeof startLine === 'number' ? startLine : 1
					const safeEndLine = typeof endLine === 'number' ? endLine : lineCount

					if (safeStartLine < 1 || safeEndLine > lineCount || safeStartLine > safeEndLine) {
						throw new Error(`Invalid line range: start_line must be >= 1 and <= end_line <= ${lineCount}`)
					}

					// 新增：检查 edits 是否存在行号交集
					const ranges = edits.map((edit, index) => ({
						start: typeof edit.startLine === 'number' ? edit.startLine : 1,
						end: typeof edit.endLine === 'number' ? edit.endLine : lineCount,
						index
					}));

					// 按 start 排序
					ranges.sort((a, b) => a.start - b.start);

					// 检查是否有重叠
					for (let i = 1; i < ranges.length; i++) {
						const prev = ranges[i - 1];
						const curr = ranges[i];
						if (curr.start <= prev.end) {
							throw new Error(
								`Edit blocks overlap at edits[${prev.index}] (lines ${prev.start}-${prev.end}) ` +
								`and edits[${curr.index}] (lines ${curr.start}-${curr.end}). Overlapping edits are not allowed.`
							);
						}
					}


					const originalFragmentWithRowIndex = LineNumberService.getContentFragment(originalContentWithRowIndex, safeStartLine, safeEndLine)
					const normalizedNewContent = newContent === undefined || newContent === null ? '' : newContent;

					let adjustedNewContent = normalizedNewContent;




					// 执行替换
					beingApplyContentWithRowIndex = beingApplyContentWithRowIndex.replace(
						originalFragmentWithRowIndex,
						adjustedNewContent
					);

					// 更新预期行数（不在此处验证）
					const originalFragmentLineCount = safeEndLine - safeStartLine + 1;
					const newContentLineCount = adjustedNewContent === ''
						? 0
						: adjustedNewContent.split('\n').length;
					let expectedTotalLineCount = lineCount; // 跟踪预期总行数
					expectedTotalLineCount = expectedTotalLineCount - originalFragmentLineCount + newContentLineCount;


					// 最终行数验证（所有编辑完成后）
					const finalContent = LineNumberService.removeFixedLineNumbers(beingApplyContentWithRowIndex);
					const actualLineCount = finalContent.split('\n').length;
					if (actualLineCount !== expectedTotalLineCount) {
						// const errorMessage = `Line count mismatch after applying edits. ` +
						// 	`Expected: ${expectedTotalLineCount} lines, ` +
						// 	`Actual: ${actualLineCount} lines. ` +
						// 	`newContentLineCount: ${newContentLineCount} lines. ` + `originalFragmentLineCount: ${originalFragmentLineCount} lines. ` +
						// 	`This is usually caused by inconsistent line endings in the replacement content.`
						// beingApplyContentWithRowIndex += ('\n' + errorMessage)
						// throw new Error(

						// );
					}
				}
				await voidModelService.initializeModel(uri)
				if (this.commandBarService.getStreamState(uri) === 'streaming') {
					throw new Error(`Another LLM is currently making changes to this file. Please stop streaming for now and ask the user to resume later.`)
				}
				await editCodeService.callBeforeApplyOrEdit(uri)
				const beingApplyContent = LineNumberService.removeFixedLineNumbers(beingApplyContentWithRowIndex)
				editCodeService.instantlyRewriteFile({ uri, newContent: beingApplyContent })
				// 可选：在短延迟后返回 lint 错误
				const resultPromise = Promise.resolve().then(async () => {

					const result = (await this.callTool['read_file']({ uri, startLine: null, endLine: null, pageNumber: 1 }) as { result: { fileContents: string; totalFileLen: number; original_line_count: number; hasNextPage: boolean; }, interruptTool: () => void }).result
					await timeout(2000)
					const { lintErrors } = this._getLintErrors(uri)
					return { lintErrors, file_content_applied: result.fileContents, original_line_count: `${result.original_line_count}` }
				})
				return { result: resultPromise }
			},

			insert_file_blocks: async ({ uri, original_line_count, edits }) => {
				// 初始化模型
				await voidModelService.initializeModel(uri)
				const { model } = await voidModelService.getModelSafe(uri)
				if (model === null) {
					throw new Error(`File does not exist or could not be loaded.`)
				}
				const lineCount = model.getLineCount()
				if (original_line_count !== lineCount) {
					throw new Error(`File content has been changed. Please refresh the file and try again.current line count:${lineCount},your file version line count:${original_line_count}`)

				}
				// 检查是否有其他流式操作正在进行
				if (this.commandBarService.getStreamState(uri) === 'streaming') {
					throw new Error(`Another LLM is currently making changes to this file. Please stop streaming for now and ask the user to resume later.`)
				}

				let originalContent = model.getValue(EndOfLinePreference.LF)
				let originalContentWithRowIndex = LineNumberService.addLineNumbers(originalContent)
				let beingApplyContentWithRowIndex = originalContentWithRowIndex
				// 遍历所有编辑项并应用
				for (const edit of edits) {
					const { line_index, new_content, before_after } = edit

					// 确保行号有效
					const safe_line_index = typeof line_index === 'number' ? line_index : 1


					if (safe_line_index < 1 || safe_line_index > lineCount) {
						throw new Error(`Invalid line range: safe_line_index must be >= 1 <= ${lineCount}`)
					}

					const originalFragmentWithRowIndex = LineNumberService.getContentFragment(originalContentWithRowIndex, safe_line_index, safe_line_index)
					const newLine = '\n'
					let newContentAppendOri = originalContentWithRowIndex
					let extractLine = 0
					if (originalContentWithRowIndex === '') {
						newContentAppendOri = new_content
					}
					if (before_after == 'before') {
						newContentAppendOri = new_content + newLine + originalFragmentWithRowIndex
						extractLine++
					}
					else {
						newContentAppendOri = originalFragmentWithRowIndex + newLine + new_content
						extractLine++
					}
					beingApplyContentWithRowIndex = beingApplyContentWithRowIndex.replace(originalFragmentWithRowIndex, newContentAppendOri)
					// let expectedAddedLines = LineNumberService.getLineCount(new_content)
					// // 验证替换后的行数是否匹配
					// const currentLineCount = LineNumberService.getLineCount(beingApplyContentWithRowIndex)
					// const expectedLineCount = lineCount + expectedAddedLines

					// if (currentLineCount !== expectedLineCount) {
					// 	throw new Error(`Line count mismatch after applying insert. Expected ${expectedLineCount} lines but got ${currentLineCount}. The edit may have corrupted the file structure.`)
					// }
				}
				await voidModelService.initializeModel(uri)
				if (this.commandBarService.getStreamState(uri) === 'streaming') {
					throw new Error(`Another LLM is currently making changes to this file. Please stop streaming for now and ask the user to resume later.`)
				}
				await editCodeService.callBeforeApplyOrEdit(uri)
				const beingApplyContent = LineNumberService.removeFixedLineNumbers(beingApplyContentWithRowIndex)
				editCodeService.instantlyRewriteFile({ uri, newContent: beingApplyContent })
				// 可选：在短延迟后返回 lint 错误
				const resultPromise = Promise.resolve().then(async () => {

					const result = (await this.callTool['read_file']({ uri, startLine: null, endLine: null, pageNumber: 1 }) as { result: { fileContents: string; totalFileLen: number; original_line_count: number; hasNextPage: boolean; }, interruptTool: () => void }).result
					await timeout(2000)
					const { lintErrors } = this._getLintErrors(uri)
					return { lintErrors, file_content_applied: result.fileContents, original_line_count: `${result.original_line_count}` }
				})
				return { result: resultPromise }
			},
			// ---
			run_command: async ({ command, cwd, terminalId }) => {
				const { resPromise, interrupt } = await this.terminalToolService.runCommand(command, { type: 'temporary', cwd, terminalId })
				return { result: resPromise, interruptTool: interrupt }
			},
			run_persistent_command: async ({ command, persistentTerminalId }) => {
				const { resPromise, interrupt } = await this.terminalToolService.runCommand(command, { type: 'persistent', persistentTerminalId })
				return { result: resPromise, interruptTool: interrupt }
			},
			open_persistent_terminal: async ({ cwd }) => {
				const persistentTerminalId = await this.terminalToolService.createPersistentTerminal({ cwd })
				return { result: { persistentTerminalId } }
			},
			kill_persistent_terminal: async ({ persistentTerminalId }) => {
				// Close the background terminal by sending exit
				await this.terminalToolService.killPersistentTerminal(persistentTerminalId)
				return { result: {} }
			},
		}


		const nextPageStr = (hasNextPage: boolean) => hasNextPage ? '\n\n(more on next page...)' : ''

		const stringifyLintErrors = (lintErrors: LintErrorItem[]) => {
			return lintErrors
				.map((e, i) => `Error ${i + 1}:\nLines Affected: ${e.startLineNumber}-${e.endLineNumber}\nError message:${e.message}`)
				.join('\n\n')
				.substring(0, MAX_FILE_CHARS_PAGE)
		}

		// given to the LLM after the call for successful tool calls
		this.stringOfResult = {
			read_file: (params, result) => {
				return `${params.uri.fsPath}\n\`\`\`\n${result.fileContents}\n\`\`\`${nextPageStr(result.hasNextPage)}${result.hasNextPage ? `\nMore info because truncated: this file has ${result.original_line_count} lines, or ${result.totalFileLen} characters.` : ''}`
			},
			ls_dir: (params, result) => {
				const dirTreeStr = stringifyDirectoryTree1Deep(params, result)
				return dirTreeStr // + nextPageStr(result.hasNextPage) // already handles num results remaining
			},
			get_dir_tree: (params, result) => {
				return result.str
			},
			search_pathnames_only: (params, result) => {
				return result.uris.map(uri => uri.fsPath).join('\n') + nextPageStr(result.hasNextPage)
			},
			search_for_files: (params, result) => {
				return result.uris.map(uri => uri.fsPath).join('\n') + nextPageStr(result.hasNextPage)
			},
			search_in_file: (params, result) => {
				const { model } = voidModelService.getModel(params.uri)
				const lineCount = model?.getLineCount() || 0
				if (!model) return '<Error getting string of result>'
				const lines = result.lines.map(n => {
					const lineContent = model.getValueInRange({ startLineNumber: n, startColumn: 1, endLineNumber: n, endColumn: Number.MAX_SAFE_INTEGER }, EndOfLinePreference.LF)
					const lineContentWithRowIndex = LineNumberService.addLineNumbers(lineContent, { startAt: n })
					return `Line ${n}:\n\`\`\`\n${lineContentWithRowIndex}\n\`\`\``
				}).join('\n\n');
				return `total file original_line_count ${lineCount} lines found:\n${lines}`;

			},
			read_lint_errors: (params, result) => {
				return result.lintErrors ?
					stringifyLintErrors(result.lintErrors)
					: 'No lint errors found.'
			},
			// ---
			create_file_or_folder: (params, result) => {
				return `URI ${params.uri.fsPath} successfully created.`
			},
			delete_file_or_folder: (params, result) => {
				return `URI ${params.uri.fsPath} successfully deleted.`
			},
			edit_file: (params, result) => {
				const lintErrsString = (
					this.voidSettingsService.state.globalSettings.includeToolLintErrors ?
						(result.lintErrors ? ` Lint errors found after change:\n${stringifyLintErrors(result.lintErrors)}.\nIf this is related to a change made while calling this tool, you might want to fix the error.`
							: ` No lint errors found.`)
						: '')

				return `Change successfully made to ${params.uri.fsPath}.${lintErrsString}`
			},
			replace_file_blocks: (params, result) => {
				const lintErrsString = (
					this.voidSettingsService.state.globalSettings.includeToolLintErrors ?
						(result.lintErrors ? ` Lint errors found after change:\n${stringifyLintErrors(result.lintErrors)}.\nIf this is related to a change made while calling this tool, you might want to fix the error.`
							: ` No lint errors found.`)
						: '')

				return `Change successfully made to ${params.uri.fsPath}.${lintErrsString}\n<read_file_result>this is the file_content applied and user have got it too:\n${result.file_content_applied}</read_file_result>`
			},
			insert_file_blocks: (params, result) => {
				const lintErrsString = (
					this.voidSettingsService.state.globalSettings.includeToolLintErrors ?
						(result.lintErrors ? ` Lint errors found after change:\n${stringifyLintErrors(result.lintErrors)}.\nIf this is related to a change made while calling this tool, you might want to fix the error.`
							: ` No lint errors found.`)
						: '')

				return `Change successfully made to ${params.uri.fsPath}.${lintErrsString}\n<read_file_result>this is the file_content applied and user have got it too:\n${result.file_content_applied}</read_file_result>`
			},
			rewrite_file: (params, result) => {
				const lintErrsString = (
					this.voidSettingsService.state.globalSettings.includeToolLintErrors ?
						(result.lintErrors ? ` Lint errors found after change:\n${stringifyLintErrors(result.lintErrors)}.\nIf this is related to a change made while calling this tool, you might want to fix the error.`
							: ` No lint errors found.`)
						: '')

				return `Change successfully made to ${params.uri.fsPath}.${lintErrsString}\n<read_file_result>this is the file_content applied:\n${result.file_content_applied}</read_file_result>`
			},
			run_command: (params, result) => {
				const { resolveReason, result: result_, } = result
				// success
				if (resolveReason.type === 'done') {
					return `${result_}\n(exit code ${resolveReason.exitCode})`
				}
				// normal command
				if (resolveReason.type === 'timeout') {
					return `${result_}\nTerminal command ran, but was automatically killed by Void after ${MAX_TERMINAL_INACTIVE_TIME}s of inactivity and did not finish successfully. To try with more time, open a persistent terminal and run the command there.`
				}
				throw new Error(`Unexpected internal error: Terminal command did not resolve with a valid reason.`)
			},

			run_persistent_command: (params, result) => {
				const { resolveReason, result: result_, } = result
				const { persistentTerminalId } = params
				// success
				if (resolveReason.type === 'done') {
					return `${result_}\n(exit code ${resolveReason.exitCode})`
				}
				// bg command
				if (resolveReason.type === 'timeout') {
					return `${result_}\nTerminal command is running in terminal ${persistentTerminalId}. The given outputs are the results after ${MAX_TERMINAL_BG_COMMAND_TIME} seconds.`
				}
				throw new Error(`Unexpected internal error: Terminal command did not resolve with a valid reason.`)
			},

			open_persistent_terminal: (_params, result) => {
				const { persistentTerminalId } = result;
				return `Successfully created persistent terminal. persistentTerminalId="${persistentTerminalId}"`;
			},
			kill_persistent_terminal: (params, _result) => {
				return `Successfully closed terminal "${params.persistentTerminalId}".`;
			},
		}



	}


	private _getLintErrors(uri: URI): { lintErrors: LintErrorItem[] | null } {
		const lintErrors = this.markerService
			.read({ resource: uri })
			.filter(l => l.severity === MarkerSeverity.Error || l.severity === MarkerSeverity.Warning)
			.slice(0, 100)
			.map(l => ({
				code: typeof l.code === 'string' ? l.code : l.code?.value || '',
				message: (l.severity === MarkerSeverity.Error ? '(error) ' : '(warning) ') + l.message,
				startLineNumber: l.startLineNumber,
				endLineNumber: l.endLineNumber,
			} satisfies LintErrorItem))

		if (!lintErrors.length) return { lintErrors: null }
		return { lintErrors, }
	}


}

registerSingleton(IToolsService, ToolsService, InstantiationType.Eager);
