// src/utils/editHelper.ts

import { EditBlock, InsertBlock, UpdateBlock } from '../../common/toolsServiceTypes.js';

/**
 * 解析 XML 格式的编辑内容为 edits 数组
 * @param xmlString - 包含 <edit> 标签的字符串
 * @returns 解析后的 EditBlock 数组
 */
export function parseRawEdits(xmlString: string): Array<EditBlock> {
	const edits: Array<EditBlock> = [];

	// 清理输入
	xmlString = xmlString.trim()
		.replace('<new_content>\n', '<new_content>')
		.replace('\n</new_content>', '</new_content>');

	// 提取所有 <edit>...</edit> 块（支持跨行、非贪婪匹配）
	const editBlocks = xmlString.match(/<edit\b[^>]*>(?:(?!<\/edit>).|\n)*<\/edit>/gi) || [];

	if (editBlocks.length === 0) {
		throw new Error(`[parseRawEdits] 未找到任何 <edit> 标签\nXML 内容:\n${xmlString}`);
	}

	for (let i = 0; i < editBlocks.length; i++) {
		const block = editBlocks[i];

		// 提取字段（更灵活，支持属性和大小写不敏感）
		const lineRangeMatch = block.match(/<original_line_range\b[^>]*>(\d+):(\d+)<\/original_line_range\b[^>]*>/i);
		const newContentMatch = block.match(/<new_content\b[^>]*>([\s\S]*?)<\/new_content\b[^>]*>/i);

		const startLineStr = lineRangeMatch?.[1];
		const endLineStr = lineRangeMatch?.[2];
		const newContent = newContentMatch ? unescapeXml(newContentMatch[1]) : '';

		if (!startLineStr || !endLineStr) {
			throw new Error(`[parseRawEdits] 第 ${i + 1} 个 <edit> 缺少或格式错误的 <original_line_range>\nXML 内容:\n${block}\n完整输入:\n${xmlString}`);
		}

		const startLine = parseInt(startLineStr, 10);
		const endLine = parseInt(endLineStr, 10);

		if (isNaN(startLine)) {
			throw new Error(`[parseRawEdits] 第 ${i + 1} 个 <edit> 的 <original_line_range> 起始行不是有效数字\nXML 内容:\n${block}\n完整输入:\n${xmlString}`);
		}
		if (isNaN(endLine)) {
			throw new Error(`[parseRawEdits] 第 ${i + 1} 个 <edit> 的 <original_line_range> 结束行不是有效数字\nXML 内容:\n${block}\n完整输入:\n${xmlString}`);
		}

		edits.push({
			startLine,
			endLine,
			newContent: newContent.replace(/^\n+|\n+$/g, ''),
		});
	}

	return edits;
}

export function parseRawUpdateFileBlocks(xmlString: string): UpdateBlock[] {
	xmlString = removeXmlComments(xmlString)
	const blocks: UpdateBlock[] = [];
	const operationRegex = /<operation\s+type\s*=\s*["'](replace|delete|insert)["'][^>]*>([\s\S]*?)<\/operation>/gi;

	let match;
	while ((match = operationRegex.exec(xmlString))) {
		const type = match[1].toLowerCase() as 'replace' | 'delete' | 'insert';
		const content = match[2];

		try {
			switch (type) {
				case 'replace':
					const [replaceStart, replaceEnd] = parseLineRange(content);
					let replaceContent = extractXmlContent(content, 'content');
					replaceContent = extractContent(replaceContent)
					blocks.push(
						{
							type: 'insert',
							insert_after_line: replaceStart,  // 在删除位置后插入，先插入后删除
							newContent: replaceContent
						},
						{ type: 'delete', startLine: replaceStart, endLine: replaceEnd },
					);
					break;

				case 'delete':
					const [deleteStart, deleteEnd] = parseLineRange(content);
					blocks.push({ type: 'delete', startLine: deleteStart, endLine: deleteEnd });
					break;

				case 'insert':
					const insertAfter = extractXmlAttribute(content, 'after')
						|| extractXmlTag(content, 'insert_after_line');
					let insertContent = extractXmlContent(content, 'content');
					insertContent = extractContent(insertContent)
					blocks.push({
						type: 'insert',
						insert_after_line: parseInt(insertAfter || '0'),
						newContent: insertContent
					});
					break;

				default:
					throw new Error(`未知操作类型: ${type}`);
			}
		} catch (err) {
			throw new Error(`解析${type}操作失败: ${err.message}\n操作块: ${match[0]}`);
		}
	}

	return blocks;
}
/**
* 从 XML 字符串中提取指定标签的内容
* @param input XML 片段
* @param tagName 要提取的标签名（如 'insert_after_line'）
* @returns 标签内的文本内容（已去除首尾空格）
*/
function extractXmlTag(input: string, tagName: string): string | null {
	// 正则说明：匹配 <tagName>内容</tagName>，忽略大小写和多余空格
	const regex = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\/${tagName}>`, 'i');
	const match = input.match(regex);
	return match?.[1]?.trim() || null;
}
// 辅助函数：从XML提取内容
function extractXmlContent(input: string, tagName: string): string {
	const match = input.match(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\/${tagName}>`, 'i'));
	return match?.[1]?.trim() || '';
}

// 辅助函数：从属性提取值
function extractXmlAttribute(input: string, attrName: string): string | null {
	const match = input.match(new RegExp(`${attrName}\\s*=\\s*["']([^"']+)["']`, 'i'));
	return match?.[1] || null;
}


// 辅助函数：提取并清理内容
function extractContent(rawContent: string): string {
	// 处理 CDATA 内容
	const cdataMatch = rawContent.match(/<!\[CDATA\[([\s\S]*?)\]\]>/i);
	if (cdataMatch) {
		return cdataMatch[1].trim();
	}
	return rawContent.replace(/^\n+|\n+$/g, '');
}
function parseLineRange(input: string): [number, number] {
	// 强制匹配 <line_range start="X" end="Y"/>
	const match = input.match(/<line_range\s+start\s*=\s*["'](\d+)["']\s+end\s*=\s*["'](\d+)["']\s*\/>/);
	if (!match) {
		throw new Error(`行号范围必须为 <line_range start="X" end="Y"/> 格式`);
	}
	const start = parseInt(match[1]);
	const end = parseInt(match[2]);
	if (start > end) {
		throw new Error(`起始行号 ${start} 不能大于结束行号 ${end}`);
	}
	return [start, end];
}
/**
 * 将 file:// URI 或本地路径转换为标准化本地路径
 * - 支持 Windows (`C:\...`) 和 Unix (`/home/...`)
 * - 自动识别输入是 URI 还是本地路径
 * @param input 文件路径或 URI，如 `file:///C:/...` 或 `C:\...` 或 `/home/...`
 * @returns 标准化本地路径
 */
export function convertFileUriToPath(input: string): string {
	// 0. 如果是空值，直接返回
	if (!input) return input;

	// 1. 检查是否是 file:// URI
	if (input.startsWith('file://')) {
		// 移除 file:// 前缀并解码 URL
		let path = input.replace(/^file:\/\/\//i, '');
		path = decodeURIComponent(path);

		// 统一替换路径分隔符为当前系统的分隔符
		const isWindows = /^[a-zA-Z]:[/\\]/.test(path); // 检查是否 Windows 路径（如 C:/ 或 C:\）
		if (isWindows) {
			path = path.replace(/\//g, '\\'); // Windows 用 \
			// 确保盘符大写（可选）
			path = path.replace(/^([a-zA-Z]):\\/, (_, p1) => `${p1.toUpperCase()}:\\`);
		} else {
			path = path.replace(/\\/g, '/'); // Unix 用 /
		}

		return path;
	}

	// 2. 输入已经是本地路径，直接规范化
	const isWindowsPath = /^[a-zA-Z]:[/\\]/.test(input); // 如 C:\ 或 C:/
	if (isWindowsPath) {
		return input.replace(/\//g, '\\'); // 统一为 \
	} else {
		return input.replace(/\\/g, '/'); // 统一为 /
	}
}
/**
 * 解析 XML 格式的插入文件块内容为 insertions 数组
 * @param xmlString - 包含 <edit> 标签的字符串
 * @returns 解析后的 InsertBlock 数组
 */
export function parseRawInsertFileBlocks(xmlString: string): InsertBlock[] {
	const insertions: InsertBlock[] = [];

	// 清理输入
	xmlString = xmlString.trim()
		.replace('<new_content>\n', '<new_content>')
		.replace('\n</new_content>', '</new_content>')

	// 提取所有 <edit>...</edit> 块
	const editBlocks = xmlString.match(/<edit\b[^>]*>(?:(?!<\/edit>).|\n)*<\/edit>/gi) || [];

	if (editBlocks.length === 0) {
		throw new Error(`[parseRawInsertFileBlocks] 未找到任何 <edit> 标签\nXML 内容:\n${xmlString}`);
	}

	for (let i = 0; i < editBlocks.length; i++) {
		const block = editBlocks[i];

		const lineIndexMatch = block.match(/<insert_after_line\b[^>]*>(\d+)<\/insert_after_line\b[^>]*>/i);

		const newContentMatch = block.match(/<new_content\b[^>]*>([\s\S]*?)<\/new_content\b[^>]*>/i);

		const lineIndexStr = lineIndexMatch?.[1];
		const newContent = newContentMatch ? unescapeXml(newContentMatch[1]) : '';

		if (!lineIndexStr) {
			throw new Error(`[parseRawInsertFileBlocks] 第 ${i + 1} 个 <edit> 缺少 <line_index>\nXML 内容:\n${block}\n完整输入:\n${xmlString}`);
		}


		const lineIndex = parseInt(lineIndexStr, 10);


		if (isNaN(lineIndex)) {
			throw new Error(`[parseRawInsertFileBlocks] 第 ${i + 1} 个 <edit> 的 <line_index> 不是有效数字\nXML 内容:\n${block}\n完整输入:\n${xmlString}`);
		}


		insertions.push({
			insert_after_line: lineIndex,
			new_content: newContent.replace(/^\n+|\n+$/g, ''),
		});
	}

	return insertions;
}

function removeXmlComments(xmlString: string): string {
	return xmlString.replace(/<!--[\s\S]*?-->/g, '');
}
/**
 * 处理 XML 转义字符（如 < -> <, &amp; -> &, 等等）
 */
export function unescapeXml(xml: string): string {
	return xml
		.replace(/</g, '<')
		.replace(/>/g, '>')
		.replace(/&amp;/g, '&')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&#10/g, '\n')
		.replace(/&#13/g, '\r')
		.replace(/&#x27;/g, "'")
		.replace(/&#x9;/g, '\t');
}
