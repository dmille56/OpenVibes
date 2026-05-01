import { AsciiPlayer } from "@amansingh-afk/milli";
import type { Component, TUI } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";

function repeat(count: number, text = ""): string[] {
	return Array.from({ length: Math.max(0, count) }, () => text);
}

function frameToLines(player: AsciiPlayer, atMs: number, width: number): string[] {
	const lines = player.renderAnsiAt(atMs, true).replace(/\n$/, "").split("\n");
	const pad = Math.max(0, Math.floor((width - player.width) / 2));
	const left = " ".repeat(pad);
	return lines.map((line) => `${left}${line}`);
}

export class MilliOverlayComponent implements Component {
	private timer: ReturnType<typeof setInterval> | undefined;
	private readonly startedAt = Date.now();

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly player: AsciiPlayer,
		private readonly title: string,
		private readonly subtitle: string,
	) {
		this.timer = setInterval(() => this.tui.requestRender(), 80);
	}

	render(width: number): string[] {
		const animation = frameToLines(this.player, Date.now() - this.startedAt, width);
		const caption = this.theme.fg("accent", `${this.title}`);
		const hint = this.theme.fg("dim", this.subtitle);
		const topPad = repeat(Math.max(0, Math.floor((Math.max(0, (process.stdout.rows ?? 24) - animation.length - 2)) / 2)));
		return [...topPad, caption, ...animation, hint];
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
