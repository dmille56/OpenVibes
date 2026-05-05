import { AsciiPlayer, cellsToAnsi } from "@amansingh-afk/milli";
import type { CellGrid } from "@amansingh-afk/milli";
import type { Component, TUI } from "@mariozechner/pi-tui";

type PulseMode = "flash" | "settle";

const FLASH_DURATION_MS = 180;
const SETTLE_DURATION_MS = 420;

function scaleGrid(frame: CellGrid, cols: number, rows: number): CellGrid {
	const srcRows = frame.length;
	const srcCols = frame[0]?.length ?? 0;
	if (srcRows === 0 || srcCols === 0 || cols <= 0 || rows <= 0) return frame;

	const scaled: CellGrid = [];
	for (let y = 0; y < rows; y++) {
		const sy = Math.min(srcRows - 1, Math.floor((y * srcRows) / rows));
		const row = [] as CellGrid[number];
		for (let x = 0; x < cols; x++) {
			const sx = Math.min(srcCols - 1, Math.floor((x * srcCols) / cols));
			row.push(frame[sy]![sx]!);
		}
		scaled.push(row);
	}
	return scaled;
}

function frameToLines(player: AsciiPlayer, atMs: number, cols: number, rows: number): string[] {
	const frame = scaleGrid(player.frame(player.frameIndexAt(atMs)), cols, rows);
	return cellsToAnsi(frame, { color: true, background: false }).replace(/\n$/, "").split("\n");
}

function centerText(text: string, width: number): string {
	if (width <= 0) return "";
	if (text.length >= width) return text.slice(0, width);
	const padding = Math.max(0, Math.floor((width - text.length) / 2));
	return `${" ".repeat(padding)}${text}`;
}

function decoratePulse(lines: string[], width: number, mode: PulseMode): string[] {
	if (lines.length === 0) return lines;
	const bright = mode === "flash" ? "\x1b[1;38;2;255;223;120m" : "\x1b[2;38;2;167;255;198m";
	const accent = mode === "flash" ? "⚡" : "·";
	const banner = `${bright}${centerText(`${accent} TOOL ${accent}`, width)}\x1b[0m`;
	const footer = `${bright}${centerText(mode === "flash" ? "spell cast" : "settling", width)}\x1b[0m`;
	const decorated = [...lines];
	decorated[0] = banner;
	if (decorated.length > 1) decorated[decorated.length - 1] = footer;
	return decorated;
}

export class MilliOverlayComponent implements Component {
	private timer: ReturnType<typeof setInterval> | undefined;
	private readonly startedAt = Date.now();
	private pulseMode: PulseMode | undefined;
	private pulseUntil = 0;

	constructor(
		private readonly tui: TUI,
		private readonly player: AsciiPlayer,
	) {
		this.timer = setInterval(() => this.tui.requestRender(), 80);
	}

	pulse(mode: PulseMode): void {
		this.pulseMode = mode;
		this.pulseUntil = Date.now() + (mode === "flash" ? FLASH_DURATION_MS : SETTLE_DURATION_MS);
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const cols = Math.max(1, process.stdout.columns ?? width);
		const rows = Math.max(1, process.stdout.rows ?? 24);
		const lines = frameToLines(this.player, Date.now() - this.startedAt, cols, rows);
		if (!this.pulseMode) return lines;
		if (Date.now() > this.pulseUntil) {
			this.pulseMode = undefined;
			return lines;
		}
		return decoratePulse(lines, cols, this.pulseMode);
	}

	invalidate(): void {
		this.tui.requestRender();
	}

	dispose(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}
}
