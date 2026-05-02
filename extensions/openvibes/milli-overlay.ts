import { AsciiPlayer, cellsToAnsi } from "@amansingh-afk/milli";
import type { CellGrid } from "@amansingh-afk/milli";
import type { Component, TUI } from "@mariozechner/pi-tui";

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

export class MilliOverlayComponent implements Component {
	private timer: ReturnType<typeof setInterval> | undefined;
	private readonly startedAt = Date.now();

	constructor(
		private readonly tui: TUI,
		private readonly player: AsciiPlayer,
	) {
		this.timer = setInterval(() => this.tui.requestRender(), 80);
	}

	render(width: number): string[] {
		const cols = Math.max(1, process.stdout.columns ?? width);
		const rows = Math.max(1, process.stdout.rows ?? 24);
		return frameToLines(this.player, Date.now() - this.startedAt, cols, rows);
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
