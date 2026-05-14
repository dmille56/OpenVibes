import {
  CustomEditor,
  type KeybindingsManager,
} from '@mariozechner/pi-coding-agent';
import {
  matchesKey,
  type EditorTheme,
  truncateToWidth,
  visibleWidth,
  type TUI,
} from '@mariozechner/pi-tui';

const RESET = '\u001B[0m';
const SPARKS = ['✦', '✧', '⋆', '✺', '✹'] as const;
const SPINNER = ['◐', '◓', '◑', '◒'] as const;
const COLORS: Array<[number, number, number]> = [
  [255, 223, 120],
  [217, 156, 255],
  [128, 231, 255],
  [255, 170, 92],
];
const MODE_COLORS: Record<EditorMode, [number, number, number]> = {
  idle: [128, 231, 255],
  typing: [217, 156, 255],
  'agent-running': [255, 170, 92],
};
const MODE_LABELS: Record<EditorMode, string> = {
  idle: 'idle',
  typing: 'typing',
  'agent-running': 'casting',
};
const QUOTE_COLORS: Array<[number, number, number]> = [
  [255, 223, 120],
  [217, 156, 255],
  [128, 231, 255],
  [255, 170, 92],
  [167, 255, 198],
];
const MAX_SPARKS = 18;
const SPARK_LIFETIME = 7;
const FRAME_MS = 70;
const TYPING_WINDOW_MS = 900;
const QUOTE_FRAME_DIVISOR = 6;

type EditorMode = 'idle' | 'typing' | 'agent-running';

type Spark = {
  age: number;
  glyph: (typeof SPARKS)[number];
  colorIndex: number;
  offset: number;
};

function color(rgb: [number, number, number]): string {
  return `\u001B[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
}

function fitLine(line: string, width: number): string {
  const trimmed = truncateToWidth(line, width, '');
  const padding = Math.max(0, width - visibleWidth(trimmed));
  return `${trimmed}${' '.repeat(padding)}`;
}

function rightAlign(text: string, width: number): string {
  const trimmed = truncateToWidth(text, width, '');
  const padding = Math.max(0, width - visibleWidth(trimmed));
  return `${' '.repeat(padding)}${trimmed}`;
}

function colorizeTokens(text: string, paletteOffset: number): string {
  return text
    .split(/(\s+)/)
    .map((token, index) => {
      if (/^\s+$/.test(token)) return token;
      const rgb = QUOTE_COLORS[(paletteOffset + index) % QUOTE_COLORS.length];
      return `${color(rgb)}${token}${RESET}`;
    })
    .join('');
}

export class WandTrailEditor extends CustomEditor {
  private readonly sparks: Spark[] = [];
  private frame = 0;
  private animationTimer: ReturnType<typeof setInterval> | undefined;
  private lastPrintableInputAt = 0;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    private readonly isEnabled: () => boolean,
    private readonly isAgentRunning: () => boolean,
    private readonly getSelectedAnimation: () => string,
  ) {
    super(tui, theme, keybindings, {paddingX: 0});
  }

  private hasContent(): boolean {
    return this.getText().length > 0;
  }

  private isPrintableInput(data: string): boolean {
    return (
      data.length > 0 &&
      [...data].every((char) => char >= ' ' && char !== '\u007F')
    );
  }

  private burstSizeForInput(data: string): number {
    if (
      matchesKey(data, 'escape') ||
      matchesKey(data, 'ctrl+c') ||
      matchesKey(data, 'ctrl+d') ||
      matchesKey(data, 'backspace') ||
      matchesKey(data, 'delete') ||
      matchesKey(data, 'enter')
    ) {
      return 0;
    }

    if (!this.isPrintableInput(data)) return 0;
    if (data.length === 1) return 3;
    return Math.min(6, Math.max(2, Math.ceil(data.length / 4)));
  }

  private getMode(): EditorMode {
    if (this.isAgentRunning()) return 'agent-running';
    if (Date.now() - this.lastPrintableInputAt < TYPING_WINDOW_MS)
      return 'typing';
    return 'idle';
  }

  private getStatusLabel(mode: EditorMode): string {
    return MODE_LABELS[mode];
  }

  private getFrameColor(
    mode: EditorMode,
    emphasis = false,
  ): [number, number, number] {
    const base = MODE_COLORS[mode];
    return emphasis
      ? [
          Math.min(255, base[0] + 24),
          Math.min(255, base[1] + 24),
          Math.min(255, base[2] + 24),
        ]
      : base;
  }

  private buildBorderLine(width: number, left: string, right: string): string {
    if (width <= 0) return '';
    const mode = this.getMode();
    const borderColor = color(this.getFrameColor(mode));
    const innerWidth = Math.max(0, width - 2);
    if (innerWidth === 0) return `${borderColor}${left}${RESET}`;

    const cells = Array.from({length: innerWidth}, () => '─');
    const cursor = this.frame % innerWidth;
    cells[cursor] = SPINNER[this.frame % SPINNER.length]!;
    if (innerWidth > 8) {
      const auraLeft = Math.max(0, cursor - 4);
      const auraRight = Math.min(innerWidth - 1, cursor + 4);
      cells[auraLeft] = '·';
      cells[auraRight] = '·';
    }

    return `${borderColor}${left}${cells.join('')}${right}${RESET}`;
  }

  private buildPlaqueLine(width: number): string {
    if (width <= 0) return '';
    const mode = this.getMode();
    const borderColor = color(this.getFrameColor(mode));
    const accentColor = color(this.getFrameColor(mode, true));
    const dimColor = color(this.getFrameColor('idle'));
    const innerWidth = Math.max(0, width - 2);
    if (innerWidth === 0) return `${borderColor}│${RESET}`;

    const title = `${accentColor}✦ OpenVibes${RESET}`;
    const quote = colorizeTokens(
      '"Roads? Where we\'re going, we don\'t need roads."',
      Math.floor(this.frame / QUOTE_FRAME_DIVISOR),
    );
    const quoteWidth = visibleWidth(quote);
    const titleWidth =
      visibleWidth(title) + visibleWidth(`${accentColor}⋄${RESET}`) + 1;
    const gapWidth = Math.max(1, innerWidth - titleWidth - quoteWidth);
    const content = fitLine(
      `${title} ${accentColor}⋄${RESET}${' '.repeat(gapWidth)}${dimColor}${rightAlign(quote, quoteWidth)}${RESET}`,
      innerWidth,
    );
    return `${borderColor}│${RESET}${content}${borderColor}│${RESET}`;
  }

  private buildFooterLine(width: number): string {
    if (width <= 0) return '';
    const mode = this.getMode();
    const borderColor = color(this.getFrameColor(mode));
    const accentColor = color(this.getFrameColor(mode, true));
    const dimColor = color(this.getFrameColor('idle'));
    const innerWidth = Math.max(0, width - 2);
    if (innerWidth === 0) return `${borderColor}│${RESET}`;

    const left = `${accentColor}⟡ ${this.getStatusLabel(mode)}${RESET}`;
    const center = `${dimColor}· ${SPINNER[this.frame % SPINNER.length]} ·${RESET}`;
    const right = `${accentColor}${this.getSelectedAnimation()}${RESET}`;
    const content = fitLine(`${left}   ${center}   ${right}`, innerWidth);
    return `${borderColor}│${RESET}${content}${borderColor}│${RESET}`;
  }

  private pruneSparks(): void {
    for (let index = this.sparks.length - 1; index >= 0; index--) {
      if (this.sparks[index].age > SPARK_LIFETIME) {
        this.sparks.splice(index, 1);
      }
    }
  }

  private startAnimation(): void {
    if (!this.isEnabled()) return;
    if (this.animationTimer) return;
    this.animationTimer = setInterval(() => {
      if (!this.isEnabled()) {
        this.stopAnimation();
        return;
      }

      this.frame++;
      for (const spark of this.sparks) {
        spark.age++;
      }

      this.pruneSparks();
      this.tui.requestRender();
    }, FRAME_MS);
  }

  private stopAnimation(): void {
    if (this.animationTimer) {
      clearInterval(this.animationTimer);
      this.animationTimer = undefined;
    }
  }

  private spawnSparkBurst(count: number): void {
    for (let index = 0; index < count; index++) {
      this.sparks.unshift({
        age: 0,
        glyph: SPARKS[(this.frame + index) % SPARKS.length],
        colorIndex: (this.frame + index) % COLORS.length,
        offset: index,
      });
    }

    this.sparks.splice(MAX_SPARKS);
  }

  handleInput(data: string): void {
    const burstSize = this.burstSizeForInput(data);
    if (burstSize > 0) {
      this.lastPrintableInputAt = Date.now();
    }

    if (this.isEnabled() && burstSize > 0) {
      this.spawnSparkBurst(burstSize);
    }

    super.handleInput(data);
    if (this.isEnabled()) {
      this.startAnimation();
    } else {
      this.stopAnimation();
    }
  }

  render(width: number): string[] {
    if (width < 4) return super.render(width);
    const innerWidth = Math.max(1, width - 2);
    const lines = super.render(innerWidth);
    if (!this.isEnabled()) return lines;
    this.startAnimation();
    if (lines.length === 0)
      return [
        this.buildBorderLine(width, '╭', '╮'),
        this.buildPlaqueLine(width),
        this.buildFooterLine(width),
        this.buildBorderLine(width, '╰', '╯'),
      ];

    const borderColor = color(this.getFrameColor(this.getMode()));
    const body = lines.map(
      (line) =>
        `${borderColor}│${RESET}${fitLine(line, innerWidth)}${borderColor}│${RESET}`,
    );
    const currentLine = this.getText().split('\n').at(-1) ?? '';
    const head = Math.max(
      0,
      Math.min(innerWidth - 1, visibleWidth(currentLine)),
    );
    const showingAutocomplete =
      (
        this as unknown as {isShowingAutocomplete?: () => boolean}
      ).isShowingAutocomplete?.() ?? false;
    if (
      body.length > 0 &&
      !showingAutocomplete &&
      (this.hasContent() || this.sparks.length > 0)
    ) {
      const cells = Array.from({length: innerWidth}, () => ' ');
      const put = (x: number, glyph: string, rgb: [number, number, number]) => {
        if (x < 0 || x >= innerWidth) return;
        cells[x] = `${color(rgb)}${glyph}${RESET}`;
      };

      put(
        head,
        SPARKS[((this.frame / 2) % SPARKS.length) | 0],
        COLORS[this.frame % COLORS.length],
      );
      for (const spark of this.sparks) {
        const offset = spark.age * 2 + spark.offset + 2;
        const x = head - offset;
        if (x < 0) break;
        if (spark.age > SPARK_LIFETIME) continue;
        const rgb = COLORS[(spark.colorIndex + spark.age) % COLORS.length];
        put(x, spark.glyph, rgb);
      }

      body[body.length - 1] =
        `${borderColor}│${RESET}${cells.join('')}${borderColor}│${RESET}`;
    }

    return [
      this.buildBorderLine(width, '╭', '╮'),
      this.buildPlaqueLine(width),
      ...body,
      this.buildFooterLine(width),
      this.buildBorderLine(width, '╰', '╯'),
    ];
  }

  dispose(): void {
    this.stopAnimation();
    this.sparks.length = 0;
  }
}
