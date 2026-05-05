import { AsciiPlayer, cellsToAnsi } from "@amansingh-afk/milli";
import type { Cell, CellGrid } from "@amansingh-afk/milli";
import type { Component, TUI } from "@mariozechner/pi-tui";

type PulseMode = "flash" | "settle";
type ParticleGlyph = "." | "+" | "*" | ":";

interface Particle {
	x: number;
	y: number;
	vx: number;
	vy: number;
	bornAt: number;
	ttl: number;
	glyph: ParticleGlyph;
	fg: Cell["fg"];
}

const FLASH_DURATION_MS = 180;
const SETTLE_DURATION_MS = 420;
const PARTICLE_SPAWN_RATE_PER_MS = 0.0025;
const PARTICLE_TTL_MIN_MS = 900;
const PARTICLE_TTL_MAX_MS = 1800;
const PARTICLE_MAX_COUNT = 8;
const PARTICLE_GLYPHS: ParticleGlyph[] = [".", "+", "*", ":"];
const PARTICLE_COLORS: Cell["fg"][] = [
	[160, 255, 208],
	[126, 216, 255],
	[215, 255, 166],
	[255, 226, 146],
];

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

function cloneGrid(grid: CellGrid): CellGrid {
	return grid.map((row) => row.map((cell) => ({ ...cell })));
}

export class MilliOverlayComponent implements Component {
	private timer: ReturnType<typeof setInterval> | undefined;
	private readonly startedAt = Date.now();
	private lastParticleTick = this.startedAt;
	private particleBudget = 0;
	private particles: Particle[] = [];
	private pulseMode: PulseMode | undefined;
	private pulseUntil = 0;

	constructor(
		private readonly tui: TUI,
		private readonly player: AsciiPlayer,
	) {
		this.timer = setInterval(() => this.tui.requestRender(), 80);
	}

	private spawnParticle(now: number, cols: number, rows: number): Particle {
		const marginX = Math.max(2, Math.floor(cols * 0.12));
		const marginY = Math.max(1, Math.floor(rows * 0.18));
		const width = Math.max(1, cols - marginX * 2);
		const height = Math.max(1, rows - marginY * 2);
		return {
			x: marginX + Math.random() * width,
			y: marginY + Math.random() * height,
			vx: (Math.random() - 0.5) * 0.12,
			vy: -(0.08 + Math.random() * 0.16),
			bornAt: now,
			ttl: PARTICLE_TTL_MIN_MS + Math.random() * (PARTICLE_TTL_MAX_MS - PARTICLE_TTL_MIN_MS),
			glyph: PARTICLE_GLYPHS[Math.floor(Math.random() * PARTICLE_GLYPHS.length)] ?? ".",
			fg: PARTICLE_COLORS[Math.floor(Math.random() * PARTICLE_COLORS.length)] ?? PARTICLE_COLORS[0]!,
		};
	}

	private advanceParticles(now: number, cols: number, rows: number): void {
		const deltaMs = Math.max(0, now - this.lastParticleTick);
		this.lastParticleTick = now;

		for (const particle of this.particles) {
			const deltaSeconds = deltaMs / 1000;
			particle.x += particle.vx * deltaSeconds;
			particle.y += particle.vy * deltaSeconds;
		}

		this.particles = this.particles.filter((particle) => now - particle.bornAt < particle.ttl && particle.y >= -1 && particle.x >= -1 && particle.x <= cols + 1);
		this.particleBudget += deltaMs * PARTICLE_SPAWN_RATE_PER_MS;
		while (this.particleBudget >= 1 && this.particles.length < PARTICLE_MAX_COUNT) {
			this.particles.push(this.spawnParticle(now, cols, rows));
			this.particleBudget -= 1;
		}
	}

	private paintParticles(grid: CellGrid, now: number, cols: number, rows: number): CellGrid {
		if (this.particles.length === 0) return grid;
		const painted = cloneGrid(grid);
		for (const particle of this.particles) {
			const age = now - particle.bornAt;
			const fade = Math.max(0, 1 - age / particle.ttl);
			if (fade <= 0) continue;
			const x = Math.round(particle.x);
			const y = Math.round(particle.y);
			if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
			const row = painted[y];
			const cell = row?.[x];
			if (!row || !cell) continue;
			const dim = 0.35 + fade * 0.65;
			const fg = particle.fg.map((channel) => Math.max(0, Math.min(255, Math.round(channel * dim)))) as unknown as Cell["fg"];
			row[x] = {
				...cell,
				glyph: particle.glyph,
				fg,
			};
		}
		return painted;
	}

	pulse(mode: PulseMode): void {
		this.pulseMode = mode;
		this.pulseUntil = Date.now() + (mode === "flash" ? FLASH_DURATION_MS : SETTLE_DURATION_MS);
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const now = Date.now();
		const cols = Math.max(1, process.stdout.columns ?? width);
		const rows = Math.max(1, process.stdout.rows ?? 24);
		this.advanceParticles(now, cols, rows);
		const frame = this.paintParticles(scaleGrid(this.player.frameAt(now - this.startedAt), cols, rows), now, cols, rows);
		const lines = cellsToAnsi(frame, { color: true, background: false }).replace(/\n$/, "").split("\n");
		if (!this.pulseMode) return lines;
		if (now > this.pulseUntil) {
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
