/**
 * Service for adding line numbers to text content
 */
export class LineNumberService {
	/**
 * Gets the total number of lines in the content
 * @param content The text content to count lines from
 * @returns The number of lines
 */
	static getLineCount(content: string): number {
		if (!content) return 0;

		// Normalize line endings to \n and split
		const normalizedContent = content.replace(/\r\n/g, '\n');
		// Handle case where last line might be empty (no newline at EOF)
		const lines = normalizedContent.split('\n');

		// If last line is empty (due to trailing newline), don't count it
		if (lines.length > 0 && lines[lines.length - 1] === '') {
			return lines.length - 1;
		}

		return lines.length;
	}
	/**
	 * Adds line numbers to each line of text
	 * @param content The text content to process
	 * @param options Configuration options
	 * @returns Text with line numbers added
	 */
	static addLineNumbers(
		content: string,
		options: LineNumberOptions = {}
	): string {
		if (!content) return content;

		const {
			startAt = 1,
			padding = 'auto',
			excludeEmptyLines = false
		} = options;
		const normalizedContent = content.replace(/\r\n/g, '\n');
		const lines = normalizedContent.split('\n');
		const maxLineNumber = startAt + lines.length - 1;
		const padLength = padding === 'auto'
			? maxLineNumber.toString().length
			: padding;

		return lines
			.map((line, index) => {
				if (excludeEmptyLines && !line.trim()) return line;

				const currentLine = startAt + index;
				const formattedNumber = currentLine
					.toString()
					.padStart(padLength, '0');

				const expectedPrefix = `[${formattedNumber}]`;

				// Check if line already starts with the exact same line number prefix
				if (line.startsWith(expectedPrefix)) {
					return line;
				}

				return `${expectedPrefix}${line}`;
			})
			.join('\n');
	}
	/**
	 * Removes line numbers from text with support for various formats
	 * @param content Text with line numbers
	 * @returns Clean text without line numbers
	 */
	static removeFixedLineNumbers(content: string): string {
		if (!content) return content;
		return content.replace(/^\[\d+\](\s*)/gm, '$1'); // 保留序号后的空格
		// 精确匹配行首的 [数字] + 2个空格，其他空格保留
		// return content.replace(/^\[\d+\]  /gm, '');
	}
	/**
	 * Gets a content fragment between specified line numbers
	 * @param content The text content to process
	 * @param startLine 1-based starting line number (inclusive)
	 * @param endLine 1-based ending line number (inclusive)
	 * @param options Configuration options
	 * @returns The content fragment between the specified lines
	 */
	static getContentFragment(
		content: string,
		startLine: number,
		endLine: number,
		options: GetContentFragmentOptions = {}
	): string {
		if (!content) return content;
		if (startLine < 1) startLine = 1;
		if (endLine < startLine) endLine = startLine;

		const {
			includeLineNumbers = false,
			lineNumberOptions = {},
			trimEmptyLines = false
		} = options;
		const normalizedContent = content.replace(/\r\n/g, '\n');
		const lines = normalizedContent.split('\n');
		const fragmentLines = lines.slice(startLine - 1, endLine);

		// Apply trimming if requested
		let resultLines = trimEmptyLines
			? fragmentLines.filter(line => line.trim().length > 0)
			: fragmentLines;

		// Add line numbers if requested
		if (includeLineNumbers) {
			const numberedContent = resultLines.join('\n');
			return this.addLineNumbers(numberedContent, {
				...lineNumberOptions,
				startAt: startLine
			});
		}

		return resultLines.join('\n');
	}


}
export interface RemoveLineNumberOptions {
	/**
	 * Original line number format used (if known)
	 * Helps create more accurate removal pattern
	 * @default '[{lineNumber}]  '
	 */
	format?: string;

	/**
	 * Whether to preserve indentation (whitespace before line numbers)
	 * @default true
	 */
	preserveIndentation?: boolean;
}
export interface LineNumberOptions {

	/**
	 * Starting line number
	 * @default 1
	 */
	startAt?: number;

	/**
	 * Number padding:
	 * - 'auto': pads to match total line count width
	 * - number: fixed padding length
	 * @default 'auto'
	 */
	padding?: 'auto' | number;

	/**
	 * Whether to skip empty lines
	 * @default false
	 */
	excludeEmptyLines?: boolean;
}
export interface GetContentFragmentOptions {
	/**
	 * Whether to include line numbers in the fragment
	 * @default true
	 */
	includeLineNumbers?: boolean;

	/**
	 * Options for line number formatting when includeLineNumbers is true
	 */
	lineNumberOptions?: LineNumberOptions;

	/**
	 * Whether to trim empty lines from the fragment
	 * @default true
	 */
	trimEmptyLines?: boolean;
}
