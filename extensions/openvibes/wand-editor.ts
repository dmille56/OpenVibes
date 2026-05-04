import { CustomEditor, type KeybindingsManager } from "@mariozechner/pi-coding-agent";
import { matchesKey, type EditorTheme, truncateToWidth, visibleWidth, type TUI } from "@mariozechner/pi-tui";

const RESET = "\x1b[0m";
const SPARKS = ["✦", "✧", "⋆", "✺", "✹"] as const;
const COLORS: [number, number, number][] = [
	[255, 223, 120],
	[217, 156, 255],
	[128, 231, 255],
	[255, 170, 92],
];

type Spark = {
	age: number;
	glyph: (typeof SPARKS)[number];
};

function color(rgb: [number, number, number]): string {
	return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
}

export class WandTrailEditor extends CustomEditor {
	private readonly sparks: Spark[] = [];
	private frame = 0;
	private animationTimer: ReturnType<typeof setInterval> | undefined;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		private readonly isEnabled: () => boolean,
	) {
		super(tui, theme, keybindings, { paddingX: 0 });
	}

	private hasContent(): boolean {
		return this.getText().length > 0;
	}

	private startAnimation(): void {
		if (!this.isEnabled()) return;
		if (this.animationTimer) return;
		this.animationTimer = setInterval(() => {
			this.frame++;
			for (const spark of this.sparks) {
				spark.age++;
			}
			this.tui.requestRender();
			if (!this.hasContent() && this.sparks.length === 0) {
				this.stopAnimation();
			}
		}, 70);
	}

	private stopAnimation(): void {
		if (this.animationTimer) {
			clearInterval(this.animationTimer);
			this.animationTimer = undefined;
		}
	}

	private spawnSpark(): void {
		this.sparks.unshift({
			age: 0,
			glyph: SPARKS[this.frame % SPARKS.length]!,
		});
		this.sparks.splice(12);
	}

	private shouldSpark(data: string): boolean {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "ctrl+d")) return false;
		if (data.length === 1) return data.charCodeAt(0) >= 32;
		return matchesKey(data, "backspace") || matchesKey(data, "delete") || matchesKey(data, "left") || matchesKey(data, "right") || matchesKey(data, "up") || matchesKey(data, "down") || matchesKey(data, "enter") || matchesKey(data, "tab");
	}

	handleInput(data: string): void {
		if (this.isEnabled() && this.shouldSpark(data)) {
			this.spawnSpark();
		}
		super.handleInput(data);
		if (this.isEnabled() && (this.hasContent() || this.sparks.length > 0)) {
			this.startAnimation();
		} else {
			this.stopAnimation();
		}
	}

	render(width: number): string[] {
		const lines = super.render(width);
		if (!this.isEnabled()) return lines;
		if (!this.hasContent() && this.sparks.length === 0) return lines;
		if (lines.length === 0) return lines;

		const currentLine = this.getText().split("\n").at(-1) ?? "";
		const head = Math.max(0, Math.min(width - 1, visibleWidth(currentLine)));
		const cells = Array.from({ length: width }, () => " ");

		const put = (x: number, glyph: string, rgb: [number, number, number]) => {
			if (x < 0 || x >= width) return;
			cells[x] = `${color(rgb)}${glyph}${RESET}`;
		};

		put(head, SPARKS[(this.frame / 2) % SPARKS.length | 0]!, COLORS[this.frame % COLORS.length]!);
		for (const spark of this.sparks) {
			const offset = spark.age * 2 + 2;
			const x = head - offset;
			if (x < 0) break;
			if (spark.age > 8) continue;
			const rgb = COLORS[Math.min(COLORS.length - 1, spark.age) % COLORS.length]!;
			put(x, spark.glyph, rgb);
		}

		const trailLine = cells.join("");
		const trimmedTrail = truncateToWidth(trailLine, width, "");
		return [...lines.slice(0, -1), trimmedTrail, lines[lines.length - 1]!];
	}

	dispose(): void {
		this.stopAnimation();
		this.sparks.length = 0;
	}
}
