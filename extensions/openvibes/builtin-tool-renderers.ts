import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type ExtensionAPI,
} from '@mariozechner/pi-coding-agent';
import {truncateToWidth, type Component} from '@mariozechner/pi-tui';

type ThemeLike = {
  fg?: (name: string, text: string) => string;
  bold?: (text: string) => string;
};

type RenderContext = {
  lastComponent?: Component;
  isPartial?: boolean;
  isError?: boolean;
};

type RenderOptions = {
  expanded?: boolean;
  isPartial?: boolean;
};

type BuiltinTool = {
  description: string;
  parameters: unknown;
  promptSnippet?: string;
  promptGuidelines?: string[];
  prepareArguments?: unknown;
  executionMode?: unknown;
  execute: (
    toolCallId: string,
    parameters: unknown,
    signal?: AbortSignal,
    onUpdate?: unknown,
  ) => Promise<unknown>;
};

type ToolResultLike = {
  content?: Array<{type: string; text?: string}>;
  details?: Record<string, unknown> & {
    truncation?: {truncated?: boolean; totalLines?: number};
    diff?: string;
    fullOutputPath?: string;
  };
};

class MutableTextComponent implements Component {
  private text = '';

  constructor(text = '') {
    this.text = text;
  }

  setText(text: string): void {
    this.text = text;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const lines = this.text.length === 0 ? [''] : this.text.split('\n');
    return lines.map((line) => truncateToWidth(line, safeWidth));
  }

  invalidate(): void {
    void 0;
  }
}

function getComponent(
  lastComponent: Component | undefined,
): MutableTextComponent {
  if (lastComponent instanceof MutableTextComponent) {
    return lastComponent;
  }

  return new MutableTextComponent();
}

function fg(theme: ThemeLike, style: string, text: string): string {
  return theme.fg?.(style, text) ?? text;
}

function bold(theme: ThemeLike, text: string): string {
  return theme.bold?.(text) ?? text;
}

function compactPath(args: {path?: string; file_path?: string}): string {
  return args.path?.trim() || args.file_path?.trim() || 'unknown';
}

function getTextContent(result: ToolResultLike): string {
  const content = result.content?.find((item) => item.type === 'text');
  return content?.text ?? '';
}

function formatExpandedLines(
  theme: ThemeLike,
  style: string,
  lines: string[],
  maxLines: number,
): string {
  const rendered = lines
    .slice(0, maxLines)
    .map((line) => fg(theme, style, line));
  const extra =
    lines.length > maxLines
      ? `\n${fg(theme, 'muted', `... ${lines.length - maxLines} more lines`)}`
      : '';
  return `${rendered.join('\n')}${extra}`;
}

function registerReadTool(pi: ExtensionAPI): void {
  const original = createReadTool(process.cwd()) as BuiltinTool;

  pi.registerTool({
    ...original,
    renderShell: 'self',
    async execute(
      toolCallId: string,
      parameters: unknown,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
    ) {
      return original.execute(toolCallId, parameters, signal, onUpdate);
    },
    renderCall(
      args: {
        path?: string;
        file_path?: string;
        offset?: number;
        limit?: number;
      },
      theme: ThemeLike,
      context: RenderContext,
    ) {
      const component = getComponent(context.lastComponent);
      const parts = [
        fg(theme, 'toolTitle', bold(theme, 'read ')),
        fg(theme, 'accent', compactPath(args)),
      ];

      if (args.offset !== undefined || args.limit !== undefined) {
        const ranges: string[] = [];
        if (args.offset !== undefined) ranges.push(`offset=${args.offset}`);
        if (args.limit !== undefined) ranges.push(`limit=${args.limit}`);
        parts.push(fg(theme, 'dim', ` (${ranges.join(', ')})`));
      }

      component.setText(parts.join(''));
      return component;
    },
    renderResult(
      result: ToolResultLike,
      options: RenderOptions,
      theme: ThemeLike,
      context: RenderContext,
    ) {
      const component = getComponent(context.lastComponent);
      const text = getTextContent(result);

      if (text) {
        const lines = text.split('\n');
        let summary = fg(theme, 'success', `${lines.length} lines`);
        if (result.details?.truncation?.truncated) {
          summary += fg(
            theme,
            'warning',
            ` (truncated from ${result.details.truncation.totalLines ?? lines.length})`,
          );
        }

        if (!options.expanded) {
          component.setText(summary);
          return component;
        }

        component.setText(
          `${summary}\n${formatExpandedLines(theme, 'dim', lines, 20)}`,
        );
        return component;
      }

      component.setText(
        fg(theme, 'muted', options.isPartial ? 'Reading...' : 'No content'),
      );
      return component;
    },
  });
}

function registerBashTool(pi: ExtensionAPI): void {
  const original = createBashTool(process.cwd()) as BuiltinTool;

  pi.registerTool({
    ...original,
    renderShell: 'self',
    async execute(
      toolCallId: string,
      parameters: unknown,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
    ) {
      return original.execute(toolCallId, parameters, signal, onUpdate);
    },
    renderCall(
      args: {command?: string; timeout?: number},
      theme: ThemeLike,
      context: RenderContext,
    ) {
      const component = getComponent(context.lastComponent);
      const command = args.command?.trim() || '...';
      const compactCommand =
        command.length > 120 ? `${command.slice(0, 117)}...` : command;
      let timeout = '';
      if (args.timeout !== undefined) {
        timeout = fg(theme, 'dim', ` (timeout: ${args.timeout}s)`);
      }

      component.setText(
        `${fg(theme, 'toolTitle', bold(theme, '$ '))}${fg(theme, 'accent', compactCommand)}${timeout}`,
      );
      return component;
    },
    renderResult(
      result: ToolResultLike,
      options: RenderOptions,
      theme: ThemeLike,
      context: RenderContext,
    ) {
      const component = getComponent(context.lastComponent);
      const output = getTextContent(result);

      if (output) {
        const exitMatch = /exit code: (\d+)/i.exec(output);
        const exitCode = exitMatch ? Number(exitMatch[1]) : undefined;
        let summary =
          exitCode === undefined
            ? fg(theme, 'success', 'Completed')
            : exitCode === 0
              ? fg(theme, 'success', `Exit ${exitCode}`)
              : fg(theme, 'error', `Exit ${exitCode}`);

        if (result.details?.truncation?.truncated) {
          summary += fg(theme, 'warning', ' (truncated)');
        }

        if (!options.expanded) {
          component.setText(summary);
          return component;
        }

        const lines = output.split('\n');
        component.setText(
          `${summary}\n${formatExpandedLines(theme, 'dim', lines, 20)}`,
        );
        return component;
      }

      component.setText(
        fg(theme, 'warning', options.isPartial ? 'Running...' : 'No output'),
      );
      return component;
    },
  });
}

function registerEditTool(pi: ExtensionAPI): void {
  const original = createEditTool(process.cwd()) as BuiltinTool;

  pi.registerTool({
    ...original,
    renderShell: 'self',
    async execute(
      toolCallId: string,
      parameters: unknown,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
    ) {
      return original.execute(toolCallId, parameters, signal, onUpdate);
    },
    renderCall(
      args: {path?: string; file_path?: string},
      theme: ThemeLike,
      context: RenderContext,
    ) {
      const component = getComponent(context.lastComponent);
      component.setText(
        `${fg(theme, 'toolTitle', bold(theme, 'edit '))}${fg(theme, 'accent', compactPath(args))}`,
      );
      return component;
    },
    renderResult(
      result: ToolResultLike,
      options: RenderOptions,
      theme: ThemeLike,
      context: RenderContext,
    ) {
      const component = getComponent(context.lastComponent);
      const output = getTextContent(result);

      if (context.isPartial) {
        component.setText(fg(theme, 'warning', 'Editing...'));
        return component;
      }

      if (context.isError || output.startsWith('Error')) {
        component.setText(fg(theme, 'error', output || 'Edit failed'));
        return component;
      }

      const diff = result.details?.diff ?? '';
      if (!diff) {
        component.setText(fg(theme, 'success', 'Applied'));
        return component;
      }

      const diffLines = diff.split('\n');
      let additions = 0;
      let removals = 0;
      for (const line of diffLines) {
        if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
        if (line.startsWith('-') && !line.startsWith('---')) removals += 1;
      }

      const summary = `${fg(theme, 'success', `+${additions}`)}${fg(theme, 'dim', ' / ')}${fg(theme, 'error', `-${removals}`)}`;
      if (options.expanded) {
        const body = formatExpandedLines(
          theme,
          'dim',
          diffLines.map((line) => {
            if (line.startsWith('+') && !line.startsWith('+++')) {
              return fg(theme, 'success', line);
            }
            if (line.startsWith('-') && !line.startsWith('---')) {
              return fg(theme, 'error', line);
            }
            return fg(theme, 'dim', line);
          }),
          30,
        );

        component.setText(`${summary}\n${body}`);
        return component;
      }

      component.setText(summary);
      return component;
    },
  });
}

function registerWriteTool(pi: ExtensionAPI): void {
  const original = createWriteTool(process.cwd()) as BuiltinTool;

  pi.registerTool({
    ...original,
    renderShell: 'self',
    async execute(
      toolCallId: string,
      parameters: unknown,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
    ) {
      return original.execute(toolCallId, parameters, signal, onUpdate);
    },
    renderCall(
      args: {path?: string; file_path?: string; content?: string},
      theme: ThemeLike,
      context: RenderContext,
    ) {
      const component = getComponent(context.lastComponent);
      const pathText = compactPath(args);
      const contentBytes = args.content?.length ?? 0;
      component.setText(
        `${fg(theme, 'toolTitle', bold(theme, 'write '))}${fg(theme, 'accent', pathText)}${fg(theme, 'dim', ` (${contentBytes} bytes)`)}`,
      );
      return component;
    },
    renderResult(
      result: ToolResultLike,
      options: RenderOptions,
      theme: ThemeLike,
      context: RenderContext,
    ) {
      const component = getComponent(context.lastComponent);
      const output = getTextContent(result);

      if (context.isPartial) {
        component.setText(fg(theme, 'warning', 'Writing...'));
        return component;
      }

      if (context.isError || output.startsWith('Error')) {
        component.setText(fg(theme, 'error', output || 'Write failed'));
        return component;
      }

      if (options.expanded) {
        component.setText(
          output ? fg(theme, 'dim', output) : fg(theme, 'success', 'Written'),
        );
        return component;
      }

      component.setText(fg(theme, 'success', output || 'Written'));
      return component;
    },
  });
}

export function registerOpenVibesBuiltinToolRenderers(
  pi: ExtensionAPI,
  options?: {
    read?: boolean;
    bash?: boolean;
    edit?: boolean;
    write?: boolean;
  },
): void {
  const resolved = options
    ? {
        read: true,
        bash: true,
        edit: true,
        write: true,
        ...options,
      }
    : {
        read: true,
        bash: true,
        edit: true,
        write: true,
      };

  if (resolved.read) registerReadTool(pi);
  if (resolved.bash) registerBashTool(pi);
  if (resolved.edit) registerEditTool(pi);
  if (resolved.write) registerWriteTool(pi);
}

export default registerOpenVibesBuiltinToolRenderers;
