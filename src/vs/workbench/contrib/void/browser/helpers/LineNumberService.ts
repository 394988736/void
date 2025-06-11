/**
 * Service for adding line numbers to text content
 */
export class LineNumberService {
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
			format = '[{lineNumber}] ',
			startAt = 1,
			padding = 'auto',
			excludeEmptyLines = false
		} = options;

		const lines = content.split('\n');
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

				const expectedPrefix = format.replace('{lineNumber}', formattedNumber);

				// Check if line already starts with the exact same line number prefix
				if (line.startsWith(expectedPrefix)) {
					return line;
				}

				return `${expectedPrefix}${line}`;
			})
			.join('\n');
	}

	/**
	 * Removes existing line numbers from text
	 * @param content Text with line numbers
	 * @param pattern Regex pattern to match line numbers
	 * @returns Clean text without line numbers
	 */
	static removeLineNumbers(
		content: string,
		pattern: RegExp = /^\[\d+\]\s?/
	): string {
		if (!content) return content;
		return content
			.split('\n')
			.map(line => line.replace(pattern, ''))
			.join('\n');
	}
}

export interface LineNumberOptions {
	/**
	 * Format string for line numbers
	 * Available tokens:
	 * - {lineNumber}: The line number
	 * - {lineContent}: The original line content
	 * @default '[{lineNumber}]'
	 */
	format?: string;

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
