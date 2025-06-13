// src/utils/editHelper.ts

import { EditByLinesItem, InsertFileBlocksItem } from '../../common/toolsServiceTypes.js';

/**
 * 解析 XML 格式的编辑内容为 edits 数组
 * @param xmlString - 包含 <edit> 标签的字符串
 * @returns 解析后的 EditByLinesItem 数组
 */
export function parseRawEdits(xmlString: string): Array<EditByLinesItem> {
	const edits: Array<EditByLinesItem> = [];

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

/**
 * 解析 XML 格式的插入文件块内容为 insertions 数组
 * @param xmlString - 包含 <edit> 标签的字符串
 * @returns 解析后的 InsertFileBlocksItem 数组
 */
export function parseRawInsertFileBlocks(xmlString: string): InsertFileBlocksItem[] {
	const insertions: InsertFileBlocksItem[] = [];

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
