import type {Component, TUI} from '@mariozechner/pi-tui';

type BurstMode = 'flash' | 'settle';
type RGB = [number, number, number];

type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  bornAt: number;
  ttl: number;
  glyph: string;
  color: RGB;
};

const STYLE = {
  flash: {
    title: [255, 231, 157] as RGB,
    subtitle: [170, 255, 221] as RGB,
    accent: [116, 255, 211] as RGB,
    haze: [255, 176, 110] as RGB,
  },
  settle: {
    title: [220, 196, 255] as RGB,
    subtitle: [184, 189, 255] as RGB,
    accent: [138, 146, 255] as RGB,
    haze: [110, 88, 189] as RGB,
  },
} satisfies Record<
  BurstMode,
  {title: RGB; subtitle: RGB; accent: RGB; haze: RGB}
>;

function centerText(text: string, width: number): string {
  if (width <= 0) return '';
  if (text.length >= width) return text.slice(0, width);
  const padding = Math.floor((width - text.length) / 2);
  return `${' '.repeat(padding)}${text}`;
}

function colorize(
  text: string,
  rgb: RGB,
  mode: 'bold' | 'dim' | 'normal' = 'normal',
): string {
  const prefix = mode === 'bold' ? '1;' : mode === 'dim' ? '2;' : '';
  return `\u001B[${prefix}38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${text}\u001B[0m`;
}

function makeLine(
  text: string,
  width: number,
  rgb: RGB,
  mode: 'bold' | 'dim' | 'normal' = 'normal',
): string {
  return colorize(centerText(text, width), rgb, mode);
}

function makeRuneBand(width: number, glyph: string): string {
  const count = Math.max(4, Math.min(18, Math.floor(width / 9)));
  return `${glyph.repeat(count)}  ${glyph.repeat(Math.max(2, Math.floor(count / 2)))}`;
}

function placeParticle(
  line: string,
  x: number,
  glyph: string,
  color: RGB,
  bright: boolean,
): string {
  const cells = line.split('');
  if (x < 0 || x >= cells.length) return line;
  cells[x] = colorize(glyph, color, bright ? 'bold' : 'dim');
  return cells.join('');
}

export class CommandBurstOverlayComponent implements Component {
  private readonly startedAt = Date.now();
  private readonly particles: Particle[];
  private readonly timer: ReturnType<typeof setInterval>;
  private lastTick = this.startedAt;

  constructor(
    private readonly tui: TUI,
    private readonly title: string,
    private readonly subtitle: string,
    private readonly mode: BurstMode,
  ) {
    this.particles = this.seedParticles();
    this.timer = setInterval(() => {
      this.tui.requestRender();
    }, 80);
  }

  private seedParticles(): Particle[] {
    const palette = STYLE[this.mode];
    const particles: Particle[] = [];
    for (let i = 0; i < 14; i += 1) {
      const angle = (Math.PI * 2 * i) / 14 + (Math.random() - 0.5) * 0.5;
      const speed = 0.03 + Math.random() * 0.1;
      particles.push({
        x: 0,
        y: 0,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed * 0.75,
        bornAt: this.startedAt + Math.random() * 90,
        ttl: 720 + Math.random() * 420,
        glyph: ['✦', '✧', '⟡', '·'][i % 4] ?? '·',
        color: i % 2 === 0 ? palette.accent : palette.haze,
      });
    }

    return particles;
  }

  private advanceParticles(now: number, cols: number, rows: number): void {
    const deltaMs = Math.max(0, now - this.lastTick);
    this.lastTick = now;
    const centerX = cols / 2;
    const centerY = rows / 2;
    for (const particle of this.particles) {
      if (now < particle.bornAt) continue;
      const deltaSeconds = deltaMs / 1000;
      if (particle.x === 0 && particle.y === 0) {
        const offset = (Math.random() - 0.5) * 4;
        particle.x = centerX + offset;
        particle.y = centerY + offset * 0.35;
      }

      particle.x += particle.vx * deltaSeconds * cols * 8;
      particle.y += particle.vy * deltaSeconds * rows * 8;
    }
  }

  private buildFrame(width: number): string[] {
    const now = Date.now();
    const cols = Math.max(1, process.stdout.columns ?? width);
    const rows = Math.max(1, process.stdout.rows ?? 24);
    this.advanceParticles(now, cols, rows);

    const lines = Array.from({length: rows}, () => ' '.repeat(cols));
    const palette = STYLE[this.mode];
    const center = Math.floor(rows / 2);
    const titleRow = Math.max(0, center - 1);
    const subtitleRow = Math.min(rows - 1, center);
    const topRow = Math.max(0, center - 3);
    const bottomRow = Math.min(rows - 1, center + 2);
    const titleAge = now - this.startedAt;
    const fade = Math.max(0, 1 - titleAge / 1100);
    const bright = fade > 0.45;

    lines[topRow] = makeLine(
      makeRuneBand(cols, this.mode === 'flash' ? '✧' : '⟡'),
      cols,
      palette.haze,
      bright ? 'bold' : 'dim',
    );
    lines[titleRow] = makeLine(this.title, cols, palette.title, 'bold');
    lines[subtitleRow] = makeLine(
      this.subtitle,
      cols,
      palette.subtitle,
      bright ? 'normal' : 'dim',
    );
    lines[bottomRow] = makeLine(
      makeRuneBand(cols, '·'),
      cols,
      palette.accent,
      'dim',
    );

    for (const particle of this.particles) {
      if (now < particle.bornAt) continue;
      const age = now - particle.bornAt;
      if (age > particle.ttl) continue;
      const x = Math.round(particle.x);
      const y = Math.round(particle.y);
      if (
        y < 0 ||
        y >= rows ||
        y === topRow ||
        y === titleRow ||
        y === subtitleRow ||
        y === bottomRow
      )
        continue;
      const lineFade = Math.max(0, 1 - age / particle.ttl);
      lines[y] = placeParticle(
        lines[y] ?? ' '.repeat(cols),
        x,
        particle.glyph,
        particle.color,
        lineFade > 0.5,
      );
    }

    return lines;
  }

  render(width: number): string[] {
    return this.buildFrame(width);
  }

  invalidate(): void {
    this.tui.requestRender();
  }

  dispose(): void {
    clearInterval(this.timer);
  }
}
