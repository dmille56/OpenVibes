declare module '@mariozechner/pi-tui' {
  export type Component = {
    render(width: number): string[];
    handleInput?(data: string): void;
    wantsKeyRelease?: boolean;
    invalidate(): void;
  };

  export type TUI = {
    requestRender(): void;
  };

  export type EditorTheme = {
    fg?(name: string, text: string): string;
    bold?(text: string): string;
  };

  export type KeybindingsManager = Record<string, unknown>;

  export function matchesKey(data: string, key: string): boolean;
  export function truncateToWidth(
    text: string,
    width: number,
    ellipsis?: string,
  ): string;
  export function visibleWidth(text: string): number;
}

declare module '@mariozechner/pi-coding-agent' {
  import type {
    Component,
    EditorTheme,
    KeybindingsManager as TUIKeybindingsManager,
    TUI,
  } from '@mariozechner/pi-tui';

  export type ExtensionContext = {
    hasUI: boolean;
    ui: {
      setEditorComponent(
        factory?: (
          tui: TUI,
          theme: EditorTheme,
          keybindings: TUIKeybindingsManager,
        ) => CustomEditor,
      ): void;
      setStatus(key: string, text: string): void;
      notify(message: string, level?: string): void;
      select(prompt: string, items: string[]): Promise<string | undefined>;
      onTerminalInput?(
        handler: (
          data: string,
        ) => {consume?: boolean; data?: string} | undefined,
      ): () => void;
      custom<T = unknown>(
        factory: (
          tui: TUI,
          theme: EditorTheme,
          keybindings: KeybindingsManager,
          done: (value?: T) => void,
        ) => Component,
        options?: unknown,
      ): Promise<T | undefined>;
      setWorkingVisible?(visible: boolean): void;
      getEditorComponent?():
        | ((
            tui: TUI,
            theme: EditorTheme,
            keybindings: TUIKeybindingsManager,
          ) => CustomEditor)
        | undefined;
    };
    sessionManager: {
      getBranch(): Array<{type: string; customType?: string; data?: unknown}>;
      getEntries?(): Array<{type: string; customType?: string; data?: unknown}>;
    };
    abort(): void;
  };

  export type ExtensionCommandContext = {} & ExtensionContext;

  export type KeybindingsManager = TUIKeybindingsManager;

  export type ExtensionAPI = {
    events: {
      on(
        event: string,
        handler: (...args: any[]) => void | Promise<void>,
      ): void;
    };
    on(
      event: 'context',
      handler: (event: {
        messages: any[];
      }) => void | Promise<{messages: any[]} | void>,
    ): void;
    on(
      event: 'session_start' | 'agent_start' | 'agent_end' | 'session_shutdown',
      handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>,
    ): void;
    on(
      event: 'message_start' | 'message_update' | 'message_end',
      handler: (
        event: {message: {role: string; content: unknown}},
        ctx: ExtensionContext,
      ) => void | Promise<void>,
    ): void;
    on(
      event: 'tool_execution_start' | 'tool_execution_end',
      handler: (
        event: {tool?: {name?: string}},
        ctx: ExtensionContext,
      ) => void | Promise<void>,
    ): void;
    on(event: string, handler: (...args: any[]) => void | Promise<void>): void;

    registerCommand(
      name: string,
      options: {
        description: string;
        handler: (
          args: string,
          ctx: ExtensionCommandContext,
        ) => void | Promise<void>;
      },
    ): void;
    appendEntry(customType: string, data?: unknown): void;
  };

  export class CustomEditor implements Component {
    protected readonly tui: TUI;
    constructor(
      tui: TUI,
      theme: EditorTheme,
      keybindings: TUIKeybindingsManager,
      options?: {paddingX?: number; paddingY?: number},
    );
    handleInput(data: string): void;
    render(width: number): string[];
    invalidate(): void;
    getText(): string;
    dispose?(): void;
  }
}
