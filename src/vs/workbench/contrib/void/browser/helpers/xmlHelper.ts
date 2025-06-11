// src/utils/editHelper.ts

import { EditByLinesItem } from '../../common/toolsServiceTypes.js'

/**
 * 解析 XML 格式的编辑内容为 edits 数组
 * @param xmlString - 包含 <edit> 标签的字符串
 * @returns 解析后的 EditByLinesItem 数组
 */
export function parseRawEdits(xmlString: string): Array<EditByLinesItem> {
	const edits: Array<EditByLinesItem> = [];

	// 匹配所有 <edit>...</edit> 块
	const editBlocks = xmlString.match(/<edit>[\s\S]*?<\/edit>/g) || [];

	for (const block of editBlocks) {
		const startLineMatch = block.match(/<startLine>(\d+)<\/startLine>/);
		const endLineMatch = block.match(/<endLine>(\d+)<\/endLine>/);
		const newContentMatch = block.match(/<newContent>([\s\S]*?)<\/newContent>/);

		const startLine = startLineMatch ? parseInt(startLineMatch[1], 10) : null;
		const endLine = endLineMatch ? parseInt(endLineMatch[1], 10) : null;
		const newContent = newContentMatch ? newContentMatch[1] : '';

		edits.push({
			startLine,
			endLine,
			newContent,
		});
	}

	return edits;
}
