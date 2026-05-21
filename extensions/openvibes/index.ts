import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from '@mariozechner/pi-coding-agent';
import {matchesKey, type Component} from '@mariozechner/pi-tui';
import {OpenVibesAudioManager} from './audio.js';
import {registerOpenVibesBuiltinToolRenderers} from './builtin-tool-renderers.js';
import {CommandBurstOverlayComponent} from './command-burst-overlay.js';
import {MilliOverlayComponent} from './milli-overlay.js';
import {WandTrailEditor} from './wand-editor.js';
import {
  defaultOpenVibesSettings,
  getOpenVibesAnimationDir,
  getOpenVibesConfigRoot,
  type OpenVibesAnimation,
  type OpenVibesSettings,
  OPENVIBES_MASK_CUSTOM_TYPE,
  readSettings,
  writeSettings,
} from './config.js';
import {
  discoverOpenVibesAnimations,
  loadOpenVibesAnimation,
} from './animations.js';

type AssistantContent = any;

type SessionMessage = {role: string; [key: string]: any};
type AssistantMessageLike = SessionMessage & {
  role: string;
  content: AssistantContent;
};
type PermissionRequestBusEvent = {
  source?: string;
  requestId?: string;
  state?: string;
};

const hiddenAssistantType = OPENVIBES_MASK_CUSTOM_TYPE;
const maskedOriginalContentKey = Symbol('openvibes.originalAssistantContent');

type MaskedAssistantDetails = {
  originalContent: AssistantContent;
};

type MaskedAssistantMessage = AssistantMessageLike & {
  [maskedOriginalContentKey]?: AssistantContent;
};

type OverlayState = {
  close: (() => void) | undefined;
  promise: Promise<unknown> | undefined;
  component: Component | undefined;
};

export default function (pi: ExtensionAPI) {
  registerOpenVibesBuiltinToolRenderers(pi);

  let settings: OpenVibesSettings = {...defaultOpenVibesSettings};
  let animations: OpenVibesAnimation[] = [];
  let overlay: OverlayState | undefined;
  let overlayStartPromise: Promise<void> | undefined;
  let commandBurstOverlay: OverlayState | undefined;
  let commandBurstStartPromise: Promise<void> | undefined;
  let uiContext: ExtensionContext | undefined;
  let terminalInputUnsubscribe: (() => void) | undefined;
  const activePermissionRequests = new Set<string>();
  let activeAskUserPrompts = 0;
  let activePlanReviews = 0;
  let activeToolExecutionDepth = 0;
  let activeToolExecutionStack: string[] = [];
  let permissionBlockingToolDepth: number | undefined;
  let permissionBlockingToolName: string | undefined;
  let overlayRestartRequested = false;
  let overlaySuppressionToken = 0;
  let abortRequested = false;
  let escapeArmed = false;
  let lastEscapeAt = 0;
  let escapeHintTimer: ReturnType<typeof setTimeout> | undefined;
  let commandFeedbackTimer: ReturnType<typeof setTimeout> | undefined;
  let permissionOverlayRestartTimer: ReturnType<typeof setTimeout> | undefined;
  let overlayPermissionCooldownRestartTimer:
    | ReturnType<typeof setTimeout>
    | undefined;

  // Permission/dialog UIs can visually stick around slightly after the
  // permission bus event resolves (approved/denied). During that window we
  // suppress overlay restarts to avoid flicker.
  let permissionUiSettleUntil: number | undefined;
  const PERMISSION_UI_SETTLE_MS = 250;

  let assistantRestoreQueue: MaskedAssistantDetails[] = [];
  let processedAssistantMessages = new WeakSet();
  let agentRunning = false;
  const audio = new OpenVibesAudioManager(
    () => settings.soundEnabled,
    () => settings.ambientEnabled,
    () => settings.volume,
  );

  const debugEnabled = process.env.OPENVIBES_DEBUG === '1';
  const debugStdoutEnabled = process.env.OPENVIBES_DEBUG_STDOUT !== '0';

  const debugLogFilePath = (() => {
    const explicit = process.env.OPENVIBES_DEBUG_LOG_FILE?.trim();
    if (explicit) return explicit;
    if (process.env.OPENVIBES_DEBUG_TO_FILE === '1') {
      return path.join(getOpenVibesConfigRoot(), 'debug.log');
    }
    return undefined;
  })();

  let debugLogWritePromise: Promise<void> = Promise.resolve();

  const debugLog = (message: string, extra?: Record<string, unknown>): void => {
    if (!debugEnabled) return;
    const ts = new Date().toISOString();

    const extraText = (() => {
      if (!extra) return '';
      if (typeof extra === 'string') return extra;
      try {
        return JSON.stringify(extra);
      } catch {
        return '[unserializable-extra]';
      }
    })();

    const linePrefix = `[OpenVibes · DEBUG] ${ts} · ${message}`;

    if (debugStdoutEnabled) {
      console.log(
        `[OpenVibes · DEBUG] ${ts} · ${message}`,
        extraText || undefined,
      );
    }

    if (!debugLogFilePath) return;

    // Fire-and-forget, but keep order via a simple promise chain.
    debugLogWritePromise = debugLogWritePromise
      .then(async () => {
        await fs.mkdir(path.dirname(debugLogFilePath), {recursive: true});
        const parts = [linePrefix];
        if (extraText) parts.push(` · ${extraText}`);
        const fileLine = `${parts.join('')}\n`;
        await fs.appendFile(debugLogFilePath, fileLine, 'utf8');
      })
      .catch(() => undefined);
  };

  const overlayDebugSnapshot = (): Record<string, unknown> => {
    const hasToolPermissionSuppression =
      permissionBlockingToolDepth !== undefined &&
      activeToolExecutionDepth >= permissionBlockingToolDepth;

    const hasPermissionUiSettling =
      permissionUiSettleUntil !== undefined &&
      Date.now() < permissionUiSettleUntil;

    const permissionUiSettleRemainingMs = permissionUiSettleUntil
      ? Math.max(0, permissionUiSettleUntil - Date.now())
      : undefined;

    return {
      overlay: overlay ? 'yes' : 'no',
      overlayStartPromise: overlayStartPromise ? 'yes' : 'no',
      overlaySuppressionToken,
      activeAskUserPrompts,
      activePermissionRequests: activePermissionRequests.size,
      activeToolExecutionDepth,
      permissionBlockingToolDepth,
      permissionBlockingToolName,
      hasToolPermissionSuppression,
      hasPermissionUiSettling,
      permissionUiSettleRemainingMs,
      hasPendingPermissionRequest: activePermissionRequests.size > 0,
      hasPendingAskUserPrompt: activeAskUserPrompts > 0,
      overlayRestartRequested,
      agentRunning,
    };
  };

  const cloneContent = (content: AssistantContent): AssistantContent =>
    structuredClone(content);

  const setEditor = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI) return;
    ctx.ui.setEditorComponent(
      (tui, theme, keybindings) =>
        new WandTrailEditor(
          tui,
          theme,
          keybindings,
          () => settings.enabled,
          () => agentRunning,
          () => settings.selectedAnimation,
        ),
    );
  };

  const detachTerminalInputListener = (): void => {
    terminalInputUnsubscribe?.();
    terminalInputUnsubscribe = undefined;
  };

  const resetEscapeAbortState = (): void => {
    if (escapeHintTimer) {
      clearTimeout(escapeHintTimer);
      escapeHintTimer = undefined;
    }

    (
      overlay?.component as
        | {setAbortHint?: (text: string | undefined) => void}
        | undefined
    )?.setAbortHint?.(undefined);
    escapeArmed = false;
    lastEscapeAt = 0;
    abortRequested = false;
  };

  const showAbortHint = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI) return;
    (
      overlay?.component as
        | {setAbortHint?: (text: string | undefined) => void}
        | undefined
    )?.setAbortHint?.('Press Escape again to abort');
    if (escapeHintTimer) {
      clearTimeout(escapeHintTimer);
    }

    escapeHintTimer = setTimeout(() => {
      escapeHintTimer = undefined;
      (
        overlay?.component as
          | {setAbortHint?: (text: string | undefined) => void}
          | undefined
      )?.setAbortHint?.(undefined);
    }, 1200);
  };

  const attachTerminalInputListener = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI || !ctx.ui.onTerminalInput) return;
    detachTerminalInputListener();
    terminalInputUnsubscribe = ctx.ui.onTerminalInput((data) => {
      if (!settings.enabled || !agentRunning || !matchesKey(data, 'escape')) {
        return undefined;
      }

      // Don’t let Escape abort the agent while the plan review UI is open.
      if (activePlanReviews > 0) return undefined;

      const now = Date.now();
      const isDoubleEscape = escapeArmed && now - lastEscapeAt < 450;
      lastEscapeAt = now;

      if (!isDoubleEscape) {
        escapeArmed = true;
        showAbortHint(ctx);
        return {consume: true};
      }

      resetEscapeAbortState();
      abortRequested = true;
      overlayRestartRequested = false;
      closeOverlay(ctx, {reason: 'escape_abort'});
      audio.stopAmbient();
      (
        overlay?.component as
          | {setAbortHint?: (text: string | undefined) => void}
          | undefined
      )?.setAbortHint?.(undefined);
      ctx.abort();
      return {consume: true};
    });
  };

  const extractVisibleText = (
    content: AssistantContent,
    seen = new WeakSet(),
  ): string => {
    if (typeof content === 'string') return content;
    if (typeof content === 'number' || typeof content === 'boolean')
      return String(content);
    if (!content || typeof content !== 'object') return '';
    if (Array.isArray(content))
      return content.map((item) => extractVisibleText(item, seen)).join('');
    if (seen.has(content)) return '';
    seen.add(content);

    const record = content as Record<string, unknown>;
    const preferredKeys = ['text', 'content', 'parts', 'children'];
    for (const key of preferredKeys) {
      const extracted = extractVisibleText(record[key], seen);
      if (extracted) return extracted;
    }

    for (const [key, value] of Object.entries(record)) {
      if (preferredKeys.includes(key)) continue;
      const extracted = extractVisibleText(value, seen);
      if (extracted) return extracted;
    }

    return '';
  };

  const buildBinaryMask = (content: AssistantContent): string => {
    const text = extractVisibleText(content);
    return text
      .split(/(\r?\n)/)
      .map((chunk) =>
        chunk === '\n' || chunk === '\r\n'
          ? chunk
          : chunk.replaceAll(/\S/g, () => (Math.random() < 0.5 ? '0' : '1')),
      )
      .join('');
  };

  const isMaskedText = (text: string): boolean =>
    text.length === 0 || /^[01\s]+$/.test(text);

  const isMaskedContent = (
    content: AssistantContent,
    seen = new WeakSet(),
  ): boolean => {
    if (typeof content === 'string') return isMaskedText(content);
    if (
      typeof content === 'number' ||
      typeof content === 'boolean' ||
      content === null ||
      content === undefined
    )
      return true;
    if (typeof content !== 'object') return true;
    if (Array.isArray(content)) {
      if (seen.has(content)) return true;
      seen.add(content);
      return content.every((item) => isMaskedContent(item, seen));
    }

    if (seen.has(content)) return true;
    seen.add(content);

    const record = content as Record<string, unknown>;
    const keysToCheck = [
      'text',
      'content',
      'parts',
      'children',
      'thinking',
      'output',
      'result',
    ];
    let checkedAny = false;
    for (const key of keysToCheck) {
      if (!(key in record)) continue;
      checkedAny = true;
      if (!isMaskedContent(record[key], seen)) return false;
    }

    return checkedAny;
  };

  const maskVisibleContent = (
    content: AssistantContent,
    seen = new WeakMap<Record<string, unknown> | AssistantContent[]>(),
  ): AssistantContent => {
    if (typeof content === 'string') return buildBinaryMask(content);
    if (
      typeof content === 'number' ||
      typeof content === 'boolean' ||
      content === null ||
      content === undefined
    )
      return content;
    if (typeof content !== 'object') return content;
    if (Array.isArray(content)) {
      if (seen.has(content)) return seen.get(content)!;
      const maskedArray: AssistantContent[] = [];
      seen.set(content, maskedArray as AssistantContent);
      for (const item of content) {
        maskedArray.push(maskVisibleContent(item, seen));
      }

      return maskedArray as AssistantContent;
    }

    if (seen.has(content)) return seen.get(content)!;

    const record = content as Record<string, unknown>;
    const maskedRecord: Record<string, unknown> = {};
    seen.set(content, maskedRecord);

    for (const [key, value] of Object.entries(record)) {
      if (
        key === 'text' ||
        key === 'thinking' ||
        key === 'output' ||
        key === 'result' ||
        key === 'content'
      ) {
        maskedRecord[key] =
          typeof value === 'string'
            ? buildBinaryMask(value)
            : maskVisibleContent(value, seen);
        continue;
      }

      if (key === 'parts' || key === 'children') {
        maskedRecord[key] = maskVisibleContent(value, seen);
        continue;
      }

      maskedRecord[key] = value;
    }

    return maskedRecord as AssistantContent;
  };

  const shouldMaskMessage = (message: SessionMessage): boolean => {
    return message.role === 'assistant';
  };

  const getMaskingLabel = (): string =>
    settings.maskAssistantOutput ? 'masking on' : 'masking off';

  const formatStatusLine = (state: string): string => {
    return `OpenVibes ${settings.enabled ? 'on' : 'off'} (${settings.selectedAnimation}) · ${state} · ${getMaskingLabel()}`;
  };

  const formatAudioStatus = (): string => {
    return `sound ${settings.soundEnabled ? 'on' : 'off'} · ambient ${settings.ambientEnabled ? 'on' : 'off'} · volume ${settings.volume.toFixed(2)}`;
  };

  const getSelectedAnimation = (): OpenVibesAnimation | undefined => {
    return (
      animations.find((item) => item.name === settings.selectedAnimation) ??
      animations[0]
    );
  };

  const persistSettings = async (): Promise<void> => {
    await writeSettings(settings);
  };

  const refreshAnimations = async (): Promise<void> => {
    animations = await discoverOpenVibesAnimations();
    if (animations.length === 0) return;
    if (!animations.some((item) => item.name === settings.selectedAnimation)) {
      settings.selectedAnimation =
        animations.find((item) => item.name === 'ai_genie')?.name ??
        animations[0].name;
      await persistSettings();
    }
  };

  const showStatus = (ctx: ExtensionContext, text: string): void => {
    if (ctx.hasUI) {
      ctx.ui.setStatus('openvibes', text);
    }
  };

  const clearCommandFeedbackTimer = (): void => {
    if (!commandFeedbackTimer) return;
    clearTimeout(commandFeedbackTimer);
    commandFeedbackTimer = undefined;
  };

  const pulseCommandFeedback = (ctx: ExtensionContext, title: string): void => {
    if (!ctx.hasUI) return;
    clearCommandFeedbackTimer();
    ctx.ui.setStatus('openvibes', `✦ ${title} ✦`);
    commandFeedbackTimer = setTimeout(() => {
      commandFeedbackTimer = undefined;
      if (!uiContext) return;
      showStatus(
        uiContext,
        settings.enabled
          ? formatStatusLine(agentRunning ? 'casting' : 'idle')
          : `OpenVibes off · ${getMaskingLabel()}`,
      );
    }, 1100);
  };

  const closeCommandBurstOverlay = (ctx: ExtensionContext): void => {
    commandBurstOverlay?.close?.();
    commandBurstOverlay = undefined;
  };

  const startCommandBurstOverlay = async (
    ctx: ExtensionContext,
    message: {title: string; subtitle: string; mode: 'flash' | 'settle'},
  ): Promise<void> => {
    if (!ctx.hasUI || commandBurstOverlay || commandBurstStartPromise) return;

    if (
      hasPendingPermissionRequest() ||
      hasPendingAskUserPrompt() ||
      hasToolPermissionSuppression()
    ) {
      debugLog('startCommandBurstOverlay() · suppressed', {
        reason: 'permission_or_ask_user_ui_active',
        snapshot: overlayDebugSnapshot(),
      });
      return;
    }

    debugLog('startCommandBurstOverlay() · starting', {
      message,
      snapshot: overlayDebugSnapshot(),
    });

    commandBurstStartPromise = (async () => {
      let closeFn: (() => void) | undefined;
      commandBurstOverlay = {
        close: undefined,
        promise: undefined,
        component: undefined,
      };
      try {
        commandBurstOverlay.promise = ctx.ui.custom(
          (tui, theme, _keybindings, done) => {
            closeFn = () => {
              done(undefined);
            };

            commandBurstOverlay!.close = closeFn;
            const component = new CommandBurstOverlayComponent(
              tui,
              message.title,
              message.subtitle,
              message.mode,
            );
            commandBurstOverlay!.component = component;
            return component;
          },
          {
            overlay: true,
            overlayOptions: {
              anchor: 'center',
              width: '100%',
              maxHeight: '100%',
              margin: 0,
            },
          },
        );
      } catch (error) {
        commandBurstOverlay = undefined;
        throw error;
      }

      const burstPromise = commandBurstOverlay.promise;
      if (!burstPromise) return;
      void burstPromise
        .catch(() => undefined)
        .finally(() => {
          if (commandBurstOverlay?.close === closeFn) {
            commandBurstOverlay = undefined;
          }
        });
      debugLog('startCommandBurstOverlay() · scheduled-close', {
        afterMs: 1050,
        snapshot: overlayDebugSnapshot(),
      });
      setTimeout(() => closeFn?.(), 1050);
    })().finally(() => {
      commandBurstStartPromise = undefined;
    });

    await commandBurstStartPromise;
  };

  const getBurstMessage = (
    action: string,
  ): {title: string; subtitle: string; mode: 'flash' | 'settle'} => {
    if (action === 'off') {
      return {
        title: 'OPENVIBES DIMS',
        subtitle: 'the veil closes',
        mode: 'settle',
      };
    }

    if (action === 'toggle' && !settings.enabled) {
      return {
        title: 'OPENVIBES DIMS',
        subtitle: 'the veil closes',
        mode: 'settle',
      };
    }

    return {
      title: 'OPENVIBES AWAKENS',
      subtitle: 'the veil stirs',
      mode: 'flash',
    };
  };

  const triggerStartupBurst = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI || !settings.enabled) return;
    void startCommandBurstOverlay(ctx, getBurstMessage('on'));
  };

  const formatStatusHelp = (): string => {
    const selected = getSelectedAnimation();
    const animationLabel = selected
      ? `${selected.name} (${selected.source === 'user' ? 'user' : 'bundled'})`
      : 'none';
    return [
      `OpenVibes: ${settings.enabled ? 'on' : 'off'}`,
      `Masking: ${settings.maskAssistantOutput ? 'on' : 'off'}`,
      `Audio: ${formatAudioStatus()}`,
      `Animation: ${animationLabel}`,
      '',
      'Usage:',
      '  /openvibes on',
      '  /openvibes off',
      '  /openvibes toggle',
      '  /openvibes mask on',
      '  /openvibes mask off',
      '  /openvibes mask toggle',
      '  /openvibes sound [status|on|off|toggle]',
      '  /openvibes ambient [status|on|off|toggle]',
      '  /openvibes volume <0-1>',
      '  /openvibes list',
      '  /openvibes select <name>',
    ].join('\n');
  };

  const parseVolume = (value: string): number | undefined => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return undefined;
    return Math.max(0, Math.min(1, parsed));
  };

  const closeOverlay = (
    ctx: ExtensionContext,
    options?: {
      restoreWorkingVisible?: boolean;
      reason?: string;
    },
  ): void => {
    const restoreWorkingVisible = options?.restoreWorkingVisible ?? true;
    const reason = options?.reason;

    debugLog('closeOverlay()', {
      phase: 'before-close',
      reason,
      restoreWorkingVisible,
      ctxHasUI: ctx.hasUI,
      snapshot: overlayDebugSnapshot(),
    });

    overlay?.close?.();
    overlay = undefined;

    if (ctx.hasUI && restoreWorkingVisible) {
      debugLog('closeOverlay()', {
        phase: 'setWorkingVisible(true)',
        reason,
        restoreWorkingVisible,
        snapshot: overlayDebugSnapshot(),
      });
      ctx.ui.setWorkingVisible?.(true);
    } else {
      debugLog('closeOverlay()', {
        phase: 'skip-setWorkingVisible(true)',
        reason,
        restoreWorkingVisible,
        ctxHasUI: ctx.hasUI,
        snapshot: overlayDebugSnapshot(),
      });
    }

    debugLog('closeOverlay()', {
      phase: 'after-close',
      reason,
      restoreWorkingVisible,
      ctxHasUI: ctx.hasUI,
      snapshot: overlayDebugSnapshot(),
    });
  };

  const clearOverlay = (options?: {
    restoreWorkingVisible?: boolean;
    reason?: string;
  }): void => {
    const restoreWorkingVisible = options?.restoreWorkingVisible ?? true;
    const reason = options?.reason;

    debugLog('clearOverlay()', {
      phase: 'before-clear',
      reason,
      restoreWorkingVisible,
      snapshot: overlayDebugSnapshot(),
    });

    overlay?.close?.();
    overlay = undefined;

    if (restoreWorkingVisible) {
      debugLog('clearOverlay()', {
        phase: 'setWorkingVisible(true)',
        reason,
        restoreWorkingVisible,
        snapshot: overlayDebugSnapshot(),
      });
      uiContext?.ui.setWorkingVisible?.(true);
    } else {
      debugLog('clearOverlay()', {
        phase: 'skip-setWorkingVisible(true)',
        reason,
        restoreWorkingVisible,
        snapshot: overlayDebugSnapshot(),
      });
    }

    debugLog('clearOverlay()', {
      phase: 'after-clear',
      reason,
      restoreWorkingVisible,
      snapshot: overlayDebugSnapshot(),
    });
  };

  const getAssistantMessagesFromBranch = (
    ctx: ExtensionContext,
  ): AssistantMessageLike[] => {
    const branch = ctx.sessionManager.getBranch() as unknown[];
    const messages: AssistantMessageLike[] = [];

    for (const entry of branch) {
      if (!entry || typeof entry !== 'object') continue;

      const entry_ = entry as {type?: unknown; message?: unknown};
      if (entry_.type !== 'message') continue;

      const message = entry_.message as AssistantMessageLike | undefined;
      if (message?.role !== 'assistant') continue;

      messages.push(message);
    }

    return messages;
  };

  const unmaskAssistantMessagesInPlace = (ctx: ExtensionContext): void => {
    if (!settings.maskAssistantOutput) return;

    for (const message of getAssistantMessagesFromBranch(ctx)) {
      const maskedMessage = message as MaskedAssistantMessage;
      const originalContent = maskedMessage[maskedOriginalContentKey];
      if (originalContent !== undefined) {
        message.content = originalContent;
      }
    }
  };

  const remaskAssistantMessagesInPlace = (ctx: ExtensionContext): void => {
    if (!settings.maskAssistantOutput) return;

    for (const message of getAssistantMessagesFromBranch(ctx)) {
      const maskedMessage = message as MaskedAssistantMessage;
      const originalContent = maskedMessage[maskedOriginalContentKey];
      if (originalContent === undefined) continue;

      message.content = maskVisibleContent(originalContent);
    }
  };

  const beginPlanReview = (ctx: ExtensionContext): void => {
    activePlanReviews++;
    overlaySuppressionToken++;

    resetEscapeAbortState();
    if (overlay) closeOverlay(ctx, {reason: 'plan_review_begin'});

    unmaskAssistantMessagesInPlace(ctx);

    if (settings.soundEnabled && settings.ambientEnabled && agentRunning) {
      const force = activePlanReviews > 1;
      void audio.startAmbient({mode: 'permission', force});
    }
  };

  const endPlanReview = (ctx: ExtensionContext): void => {
    if (activePlanReviews <= 0) return;

    activePlanReviews--;
    if (activePlanReviews !== 0) return;

    remaskAssistantMessagesInPlace(ctx);

    if (settings.soundEnabled && settings.ambientEnabled && agentRunning) {
      void audio.startAmbient({mode: 'main', force: true});
    }

    requestOverlayRestart();
  };

  const requestOverlayRestart = (): void => {
    overlayRestartRequested = true;
    const permissionUiSettlingRemainingMs =
      permissionUiSettleUntil === undefined
        ? undefined
        : Math.max(0, permissionUiSettleUntil - Date.now());

    debugLog('requestOverlayRestart()', {
      snapshot: overlayDebugSnapshot(),
      permissionUiSettlingRemainingMs,
    });

    if (
      !uiContext ||
      abortRequested ||
      !settings.enabled ||
      !agentRunning ||
      activePlanReviews > 0 ||
      hasPendingPermissionRequest() ||
      hasToolPermissionSuppression() ||
      hasPendingAskUserPrompt()
    ) {
      debugLog('requestOverlayRestart() · not starting', {
        reason: 'guard-failed',
        permissionUiSettlingRemainingMs,
        snapshot: overlayDebugSnapshot(),
      });

      if (
        permissionUiSettlingRemainingMs !== undefined &&
        permissionUiSettlingRemainingMs > 0 &&
        uiContext &&
        !abortRequested &&
        settings.enabled &&
        agentRunning
      ) {
        if (overlayPermissionCooldownRestartTimer) {
          clearTimeout(overlayPermissionCooldownRestartTimer);
          overlayPermissionCooldownRestartTimer = undefined;
        }

        debugLog('requestOverlayRestart() · cooldown-blocked · scheduling', {
          afterMs: permissionUiSettlingRemainingMs,
          snapshot: overlayDebugSnapshot(),
        });

        overlayPermissionCooldownRestartTimer = setTimeout(() => {
          overlayPermissionCooldownRestartTimer = undefined;
          requestOverlayRestart();
        }, permissionUiSettlingRemainingMs);
      }

      return;
    }
    if (overlayStartPromise || overlay) {
      debugLog('requestOverlayRestart() · not starting', {
        reason: 'already-starting-or-mounted',
        snapshot: overlayDebugSnapshot(),
      });
      return;
    }
    overlayRestartRequested = false;
    debugLog('requestOverlayRestart() · starting startOverlay', {
      snapshot: overlayDebugSnapshot(),
    });
    void startOverlay(uiContext);
  };

  const hasPendingPermissionRequest = (): boolean =>
    activePermissionRequests.size > 0;
  const hasPendingAskUserPrompt = (): boolean => activeAskUserPrompts > 0;

  const hasToolPermissionSuppression = (): boolean => {
    const toolSuppression =
      permissionBlockingToolDepth !== undefined &&
      activeToolExecutionDepth >= permissionBlockingToolDepth;

    const permissionUiSettling =
      permissionUiSettleUntil !== undefined &&
      Date.now() < permissionUiSettleUntil;

    return toolSuppression || permissionUiSettling;
  };

  const isBlockingTool = (name?: string): boolean =>
    name === 'ask_user' ||
    name === 'ask_user_question' ||
    name === 'request_user_input';

  const extractToolName = (event: unknown): string | undefined => {
    if (!event || typeof event !== 'object') return undefined;
    const event_ = event as Record<string, unknown> & {
      tool?: {name?: unknown; id?: unknown};
      toolName?: unknown;
      name?: unknown;
    };

    const candidates: unknown[] = [
      event_.tool?.name,
      event_.tool?.id,
      event_.toolName,
      event_.name,
    ];

    for (const candidate of candidates) {
      if (typeof candidate !== 'string') continue;
      const trimmed = candidate.trim();
      if (!trimmed) continue;
      return trimmed;
    }

    return undefined;
  };

  const debugRequestUserInput =
    process.env.OPENVIBES_DEBUG_REQUEST_USER_INPUT === '1';

  const debugToolState = (ctx: ExtensionContext, message: string): void => {
    if (!debugRequestUserInput) return;
    showStatus(ctx, `OpenVibes · DEBUG · ${message}`);
  };

  const handlePermissionRequestEvent = (data: unknown): void => {
    if (!data || typeof data !== 'object') return;
    const event = data as PermissionRequestBusEvent;
    const {requestId: requestIdRaw, state, source} = event;
    const requestId = requestIdRaw?.trim();
    if (!requestId) return;

    const isResolved = state === 'approved' || state === 'denied';

    debugLog('permission-request', {
      phase: 'received',
      requestId,
      source,
      state,
      treatedAs: isResolved ? 'resolved' : 'pending',
      snapshot: overlayDebugSnapshot(),
    });

    if (isResolved) {
      const hadPending = activePermissionRequests.delete(requestId);

      const now = Date.now();
      const nextUntil = now + PERMISSION_UI_SETTLE_MS;
      const previousUntil = permissionUiSettleUntil ?? 0;
      permissionUiSettleUntil = Math.max(previousUntil, nextUntil);

      const permissionUiSettleRemainingMs = Math.max(
        0,
        permissionUiSettleUntil - now,
      );

      debugLog('permission-request', {
        phase: 'resolved',
        requestId,
        source,
        state,
        hadPending,
        pendingPermissionCount: activePermissionRequests.size,
        permissionUiSettleUntil,
        permissionUiSettleRemainingMs,
        snapshot: overlayDebugSnapshot(),
      });

      if (
        activePermissionRequests.size === 0 &&
        settings.enabled &&
        settings.soundEnabled &&
        settings.ambientEnabled &&
        agentRunning &&
        !(
          permissionBlockingToolDepth !== undefined &&
          activeToolExecutionDepth >= permissionBlockingToolDepth
        )
      ) {
        void audio.startAmbient({mode: 'main', force: true});
      }

      if (permissionOverlayRestartTimer) {
        clearTimeout(permissionOverlayRestartTimer);
        permissionOverlayRestartTimer = undefined;
      }

      if (activePermissionRequests.size === 0) {
        debugLog('permission-request', {
          phase: 'scheduleOverlayRestart() · permissionUiCooldown',
          pendingPermissionCount: activePermissionRequests.size,
          permissionUiSettleRemainingMs,
        });

        permissionOverlayRestartTimer = setTimeout(() => {
          permissionOverlayRestartTimer = undefined;
          requestOverlayRestart();
        }, permissionUiSettleRemainingMs);
      } else {
        debugLog('permission-request', {
          phase: 'skipOverlayRestart() · stillPending',
          pendingPermissionCount: activePermissionRequests.size,
        });
      }

      return;
    }

    // Pending state (waiting / processing / prompt / etc.)
    if (permissionUiSettleUntil !== undefined) {
      debugLog('permission-request', {
        phase: 'pending-clearPermissionUiCooldown',
        requestId,
        permissionUiSettleUntil,
        snapshot: overlayDebugSnapshot(),
      });
    }
    permissionUiSettleUntil = undefined;
    if (overlayPermissionCooldownRestartTimer) {
      clearTimeout(overlayPermissionCooldownRestartTimer);
      overlayPermissionCooldownRestartTimer = undefined;
    }

    const wasAlreadyPending = activePermissionRequests.has(requestId);
    activePermissionRequests.add(requestId);

    if (permissionOverlayRestartTimer) {
      clearTimeout(permissionOverlayRestartTimer);
      permissionOverlayRestartTimer = undefined;
    }

    if (!wasAlreadyPending) {
      // Bump the suppression token so any in-flight overlay start/mount
      // can't complete after the permission UI appears.
      overlaySuppressionToken++;
    }

    if (activeToolExecutionDepth > 0) {
      permissionBlockingToolDepth =
        permissionBlockingToolDepth === undefined
          ? activeToolExecutionDepth
          : Math.max(permissionBlockingToolDepth, activeToolExecutionDepth);
      permissionBlockingToolName = source ?? activeToolExecutionStack.at(-1);
    }

    debugLog('permission-request', {
      phase: 'pending',
      requestId,
      source,
      state,
      wasAlreadyPending,
      pendingPermissionCount: activePermissionRequests.size,
      snapshot: overlayDebugSnapshot(),
    });

    if (overlay) {
      clearOverlay({
        restoreWorkingVisible: false,
        reason: 'permission_request_pending',
      });
    }

    overlayRestartRequested = true;

    if (
      settings.enabled &&
      settings.soundEnabled &&
      settings.ambientEnabled &&
      agentRunning
    ) {
      // When multiple permission requests overlap, force a fresh permission-ambient selection
      // so the audio stays meaningfully distinct.
      const force = activePermissionRequests.size > 1;
      void audio.startAmbient({mode: 'permission', force});
    }
  };

  const pulseOverlay = (mode: 'flash' | 'settle'): void => {
    (
      overlay?.component as
        | {pulse?: (mode: 'flash' | 'settle') => void}
        | undefined
    )?.pulse?.(mode);
  };

  const startOverlay = async (ctx: ExtensionContext): Promise<void> => {
    if (
      !ctx.hasUI ||
      abortRequested ||
      !settings.enabled ||
      overlay ||
      overlayStartPromise
    )
      return;

    const tokenAtStart = overlaySuppressionToken;

    debugLog('startOverlay()', {
      phase: 'init',
      tokenAtStart,
      animationSelection: settings.selectedAnimation,
      snapshot: overlayDebugSnapshot(),
    });

    overlayStartPromise = (async () => {
      const animation = getSelectedAnimation();
      if (!animation) return;
      let player;
      try {
        player = await loadOpenVibesAnimation(animation.path);
      } catch (error) {
        ctx.ui.notify(
          `Failed to load OpenVibes animation ${animation.name}: ${error}`,
          'error',
        );
        return;
      }

      debugLog('startOverlay()', {
        phase: 'animation-loaded',
        animationName: animation.name,
        tokenAtStart,
        currentToken: overlaySuppressionToken,
        snapshot: overlayDebugSnapshot(),
      });

      // If a blocking prompt started while we were loading, abort.
      if (tokenAtStart !== overlaySuppressionToken) {
        debugLog('startOverlay()', {
          phase: 'aborted',
          reason: 'token-mismatch-after-load',
          tokenAtStart,
          currentToken: overlaySuppressionToken,
        });
        return;
      }

      const permissionUiSettling =
        permissionUiSettleUntil !== undefined &&
        Date.now() < permissionUiSettleUntil;
      const permissionUiSettleRemainingMs = permissionUiSettleUntil
        ? Math.max(0, permissionUiSettleUntil - Date.now())
        : undefined;

      if (
        !ctx.hasUI ||
        tokenAtStart !== overlaySuppressionToken ||
        hasPendingPermissionRequest() ||
        hasPendingAskUserPrompt() ||
        hasToolPermissionSuppression()
      ) {
        if (permissionUiSettling) {
          debugLog('startOverlay() · suppressed-by-permissionUiCooldown', {
            permissionUiSettleRemainingMs,
            snapshot: overlayDebugSnapshot(),
          });
        }
        return;
      }

      let closeFn: (() => void) | undefined;
      overlay = {close: undefined, promise: undefined, component: undefined};
      try {
        overlay.promise = ctx.ui.custom(
          (tui, theme, _keybindings, done) => {
            debugLog('overlay-custom()', {
              phase: 'mount-callback-start',
              tokenAtStart,
              currentToken: overlaySuppressionToken,
              snapshot: overlayDebugSnapshot(),
            });

            // Belt-and-suspenders: if a suppression token changed just as
            // we're mounting, close immediately.
            if (tokenAtStart !== overlaySuppressionToken) {
              debugLog('overlay-custom()', {
                phase: 'mount-belt-abort',
                reason: 'token-mismatch',
                tokenAtStart,
                currentToken: overlaySuppressionToken,
              });
              done(undefined);
            }

            closeFn = () => {
              debugLog('overlay-custom()', {
                phase: 'closeFn-called',
                tokenAtStart,
                currentToken: overlaySuppressionToken,
              });
              done(undefined);
            };

            overlay!.close = closeFn;
            const component = new MilliOverlayComponent(tui, player);
            overlay!.component = component;

            if (
              tokenAtStart !== overlaySuppressionToken ||
              hasPendingPermissionRequest() ||
              hasPendingAskUserPrompt() ||
              hasToolPermissionSuppression()
            ) {
              closeFn();
            }

            return component;
          },
          {
            overlay: true,
            overlayOptions: {
              anchor: 'center',
              width: '100%',
              maxHeight: '100%',
              margin: 0,
            },
          },
        );
      } catch (error) {
        overlay = undefined;
        throw error;
      }

      // If we were suppressed after mounting, close immediately.
      if (
        tokenAtStart !== overlaySuppressionToken ||
        hasPendingPermissionRequest() ||
        hasPendingAskUserPrompt() ||
        hasToolPermissionSuppression()
      ) {
        closeFn?.();
        overlay = undefined;
        return;
      }

      debugLog('startOverlay()', {
        phase: 'setWorkingVisible(false)',
        tokenAtStart,
        snapshot: overlayDebugSnapshot(),
      });
      ctx.ui.setWorkingVisible?.(false);
      const overlayPromise = overlay.promise;
      if (!overlayPromise) return;
      void overlayPromise
        .catch(() => undefined)
        .finally(() => {
          if (overlay?.close === closeFn) {
            overlay = undefined;
          }
        });
    })().finally(() => {
      overlayStartPromise = undefined;
      const tokenIsStillClear = overlaySuppressionToken === tokenAtStart;
      if (
        overlayRestartRequested &&
        uiContext &&
        settings.enabled &&
        agentRunning &&
        tokenIsStillClear &&
        !hasPendingPermissionRequest() &&
        !hasPendingAskUserPrompt() &&
        !hasToolPermissionSuppression() &&
        !overlay
      ) {
        debugLog('startOverlay().finally() · restarting', {
          tokenAtStart,
          tokenIsStillClear,
          snapshot: overlayDebugSnapshot(),
        });
        overlayRestartRequested = false;
        void startOverlay(uiContext);
      }
    });

    await overlayStartPromise;
  };

  const syncAmbientAudio = async (): Promise<void> => {
    if (
      settings.enabled &&
      settings.soundEnabled &&
      settings.ambientEnabled &&
      agentRunning
    ) {
      await audio.startAmbient({
        mode:
          hasPendingPermissionRequest() ||
          hasPendingAskUserPrompt() ||
          hasToolPermissionSuppression()
            ? 'permission'
            : 'main',
      });
      return;
    }

    audio.stopAmbient();
  };

  const maskVisibleMessage = (
    message: SessionMessage,
    phase: 'live' | 'final' = 'live',
  ): void => {
    const maskedMessage = message as MaskedAssistantMessage;
    if (!settings.maskAssistantOutput || !shouldMaskMessage(message)) {
      const originalContent = maskedMessage[maskedOriginalContentKey];
      if (originalContent !== undefined) {
        message.content = originalContent;
      }

      return;
    }

    if (!settings.enabled) return;
    if (phase === 'live') return;
    if (typeof message !== 'object' || message === null) return;
    if (processedAssistantMessages.has(message)) return;
    processedAssistantMessages.add(message);
    if (isMaskedContent(message.content)) return;

    let originalContent = maskedMessage[maskedOriginalContentKey];
    if (originalContent === undefined) {
      originalContent = cloneContent(message.content);
      maskedMessage[maskedOriginalContentKey] = originalContent;
      const details = {originalContent};
      assistantRestoreQueue.push(details);
      pi.appendEntry(hiddenAssistantType, details);
    }

    message.content = maskVisibleContent(originalContent);
  };

  const restoreBranchQueue = (ctx: ExtensionContext): void => {
    assistantRestoreQueue = [];
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === 'custom' && entry.customType === hiddenAssistantType) {
        const details = entry.data as MaskedAssistantDetails | undefined;
        if (details?.originalContent !== undefined) {
          assistantRestoreQueue.push(details);
        }
      }
    }
  };

  const unmaskContextMessages = (
    messages: SessionMessage[],
  ): SessionMessage[] => {
    const restored: SessionMessage[] = [];
    const queue = [...assistantRestoreQueue];
    for (const message of messages) {
      restored.push(message);
      if (shouldMaskMessage(message)) {
        const details = queue.shift();
        if (details?.originalContent !== undefined) {
          message.content = details.originalContent;
        }
      }
    }

    return restored;
  };

  pi.registerCommand('openvibes', {
    description: 'Toggle OpenVibes and choose milli animations',
    async handler(args, ctx: ExtensionCommandContext) {
      const [action, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const animationName = rest.join(' ').trim();

      if (!action || action === 'status') {
        ctx.ui.notify(formatStatusHelp(), 'info');
        return;
      }

      if (action === 'toggle') {
        const nextEnabled = !settings.enabled;
        audio.play(nextEnabled ? 'on' : 'off');
        settings.enabled = !settings.enabled;
        await persistSettings();
        setEditor(ctx);
        void startCommandBurstOverlay(ctx, getBurstMessage('toggle'));
        pulseCommandFeedback(
          ctx,
          settings.enabled ? 'OPENVIBES AWAKENS' : 'OPENVIBES DIMS',
        );
        pulseOverlay(settings.enabled ? 'flash' : 'settle');
        if (settings.enabled) {
          void syncAmbientAudio();
        } else {
          audio.stopAmbient();
        }

        ctx.ui.notify(
          `OpenVibes ${settings.enabled ? 'enabled' : 'disabled'}`,
          'info',
        );
        return;
      }

      if (action === 'on') {
        audio.play('on');
        settings.enabled = true;
        await persistSettings();
        setEditor(ctx);
        void startCommandBurstOverlay(ctx, getBurstMessage('on'));
        pulseCommandFeedback(ctx, 'OPENVIBES AWAKENS');
        pulseOverlay('flash');
        void syncAmbientAudio();
        ctx.ui.notify('OpenVibes enabled', 'info');
        return;
      }

      if (action === 'off') {
        audio.play('off');
        settings.enabled = false;
        await persistSettings();
        setEditor(ctx);
        void startCommandBurstOverlay(ctx, getBurstMessage('off'));
        pulseCommandFeedback(ctx, 'OPENVIBES DIMS');
        pulseOverlay('settle');
        ctx.ui.notify('OpenVibes disabled', 'info');
        audio.stopAmbient();
        closeOverlay(ctx, {reason: 'manual_off'});
        return;
      }

      if (action === 'sound') {
        const [mode] = rest;
        if (!mode || mode === 'status') {
          ctx.ui.notify(
            `Sound is ${settings.soundEnabled ? 'on' : 'off'} (${formatAudioStatus()})`,
            'info',
          );
          return;
        }

        switch (mode) {
          case 'toggle': {
            settings.soundEnabled = !settings.soundEnabled;

            break;
          }

          case 'on': {
            settings.soundEnabled = true;

            break;
          }

          case 'off': {
            settings.soundEnabled = false;

            break;
          }

          default: {
            ctx.ui.notify(
              'Usage: /openvibes sound [status|on|off|toggle]',
              'warning',
            );
            return;
          }
        }

        await persistSettings();
        if (settings.soundEnabled) {
          void syncAmbientAudio();
        } else {
          audio.stopAmbient();
        }

        ctx.ui.notify(
          `Sound ${settings.soundEnabled ? 'enabled' : 'disabled'}`,
          'info',
        );
        return;
      }

      if (action === 'ambient') {
        const [mode] = rest;
        if (!mode || mode === 'status') {
          ctx.ui.notify(
            `Ambient is ${settings.ambientEnabled ? 'on' : 'off'}`,
            'info',
          );
          return;
        }

        switch (mode) {
          case 'toggle': {
            settings.ambientEnabled = !settings.ambientEnabled;

            break;
          }

          case 'on': {
            settings.ambientEnabled = true;

            break;
          }

          case 'off': {
            settings.ambientEnabled = false;

            break;
          }

          default: {
            ctx.ui.notify(
              'Usage: /openvibes ambient [status|on|off|toggle]',
              'warning',
            );
            return;
          }
        }

        await persistSettings();
        if (settings.ambientEnabled) {
          void syncAmbientAudio();
        } else {
          audio.stopAmbient();
        }

        ctx.ui.notify(
          `Ambient ${settings.ambientEnabled ? 'enabled' : 'disabled'}`,
          'info',
        );
        return;
      }

      if (action === 'volume') {
        const [value] = rest;
        if (!value) {
          ctx.ui.notify(
            `Usage: /openvibes volume <0-1> (current ${settings.volume.toFixed(2)})`,
            'warning',
          );
          return;
        }

        const volume = parseVolume(value);
        if (volume === undefined) {
          ctx.ui.notify('Usage: /openvibes volume <0-1>', 'warning');
          return;
        }

        settings.volume = volume;
        audio.setVolume(volume);
        await persistSettings();
        ctx.ui.notify(`Volume set to ${settings.volume.toFixed(2)}`, 'info');
        return;
      }

      if (action === 'list') {
        await refreshAnimations();
        const items = animations.map(
          (item) =>
            `${item.source === 'user' ? 'user' : 'bundled'}: ${item.name}`,
        );
        ctx.ui.notify(
          items.length > 0
            ? items.join(', ')
            : `No .milli files found in ${getOpenVibesAnimationDir()}`,
          'info',
        );
        return;
      }

      if (action === 'select') {
        await refreshAnimations();
        let choice = animationName;
        if (!choice) {
          const selected = await ctx.ui.select(
            'Choose OpenVibes animation',
            animations.map((item) => item.name),
          );
          if (!selected) return;
          choice = selected;
        }

        if (!animations.some((item) => item.name === choice)) {
          ctx.ui.notify(`Unknown animation: ${choice}`, 'error');
          return;
        }

        settings.selectedAnimation = choice;
        await persistSettings();
        showStatus(ctx, formatStatusLine(agentRunning ? 'casting' : 'idle'));
        ctx.ui.notify(`Selected ${choice}`, 'info');
        return;
      }

      if (action === 'mask') {
        const [mode] = rest;
        if (!mode || mode === 'status') {
          ctx.ui.notify(
            `Masking is ${settings.maskAssistantOutput ? 'on' : 'off'}`,
            'info',
          );
          return;
        }

        switch (mode) {
          case 'toggle': {
            settings.maskAssistantOutput = !settings.maskAssistantOutput;

            break;
          }

          case 'on': {
            settings.maskAssistantOutput = true;

            break;
          }

          case 'off': {
            settings.maskAssistantOutput = false;

            break;
          }

          default: {
            ctx.ui.notify(
              'Usage: /openvibes mask [status|on|off|toggle]',
              'warning',
            );
            return;
          }
        }

        await persistSettings();
        showStatus(
          ctx,
          settings.enabled
            ? formatStatusLine(agentRunning ? 'casting' : 'idle')
            : `OpenVibes off · ${getMaskingLabel()}`,
        );
        ctx.ui.notify(
          `Masking ${settings.maskAssistantOutput ? 'enabled' : 'disabled'}`,
          'info',
        );
        return;
      }

      ctx.ui.notify(
        'Usage: /openvibes [status|on|off|toggle|mask <mode>|sound <mode>|ambient <mode>|volume <0-1>|list|select <name>]',
        'warning',
      );
    },
  });

  pi.on('session_start', async (_event, ctx) => {
    uiContext = ctx;
    activePermissionRequests.clear();
    activeAskUserPrompts = 0;
    activeToolExecutionDepth = 0;
    activeToolExecutionStack = [];
    permissionBlockingToolDepth = undefined;
    permissionBlockingToolName = undefined;
    permissionUiSettleUntil = undefined;
    overlayRestartRequested = false;
    resetEscapeAbortState();
    clearCommandFeedbackTimer();
    if (permissionOverlayRestartTimer) {
      clearTimeout(permissionOverlayRestartTimer);
      permissionOverlayRestartTimer = undefined;
    }
    if (overlayPermissionCooldownRestartTimer) {
      clearTimeout(overlayPermissionCooldownRestartTimer);
      overlayPermissionCooldownRestartTimer = undefined;
    }
    closeCommandBurstOverlay(ctx);
    processedAssistantMessages = new WeakSet();
    settings = await readSettings();
    agentRunning = false;
    await refreshAnimations();
    restoreBranchQueue(ctx);
    setEditor(ctx);
    attachTerminalInputListener(ctx);
    showStatus(
      ctx,
      settings.enabled
        ? formatStatusLine('idle')
        : `OpenVibes off · ${getMaskingLabel()}`,
    );
    audio.play('wake');
    triggerStartupBurst(ctx);
  });

  pi.events.on(
    'pi-permission-system:permission-request',
    handlePermissionRequestEvent,
  );

  const extractCommandName = (event: unknown): string | undefined => {
    if (!event || typeof event !== 'object') return undefined;
    const event_ = event as Record<string, unknown> & {
      command?: {name?: unknown; id?: unknown};
      commandName?: unknown;
      name?: unknown;
    };

    const candidates: unknown[] = [
      event_.command?.name,
      event_.command?.id,
      event_.commandName,
      event_.name,
      event_.command,
    ];

    for (const candidate of candidates) {
      if (typeof candidate !== 'string') continue;
      const trimmed = candidate.trim();
      if (!trimmed) continue;
      return trimmed;
    }

    return undefined;
  };

  pi.events.on('command_execution_start', (...args: any[]) => {
    const [event, ctx] = args;
    const commandName = extractCommandName(event);
    if (commandName !== 'annotate-plan') return;
    if (!ctx || typeof ctx !== 'object') return;

    beginPlanReview(ctx as ExtensionContext);
  });

  pi.events.on('command_execution_end', (...args: any[]) => {
    const [event, ctx] = args;
    const commandName = extractCommandName(event);
    if (commandName !== 'annotate-plan') return;
    if (!ctx || typeof ctx !== 'object') return;

    endPlanReview(ctx as ExtensionContext);
  });

  (pi.on as any)('context', async (event: {messages: SessionMessage[]}) => {
    return {messages: unmaskContextMessages(event.messages)};
  });

  pi.on('agent_start', async (_event, ctx) => {
    uiContext = ctx;
    overlayRestartRequested = false;
    activeAskUserPrompts = 0;
    resetEscapeAbortState();
    agentRunning = true;
    if (settings.enabled) {
      void startOverlay(ctx);
    }

    audio.play('agent-start');
    void syncAmbientAudio();
    showStatus(
      ctx,
      settings.enabled
        ? formatStatusLine('casting')
        : `OpenVibes off · ${getMaskingLabel()}`,
    );
  });

  (pi.on as any)(
    'tool_execution_start',
    async (event: unknown, ctx: ExtensionContext) => {
      uiContext = ctx;
      if (!settings.enabled) return;
      audio.play('tool-tick', {throttleMs: 180});
      const toolName = extractToolName(event);
      activeToolExecutionStack.push(toolName ?? 'unknown');
      activeToolExecutionDepth = activeToolExecutionStack.length;
      const isBlockingPrompt = isBlockingTool(toolName);
      const isPlanReviewTool = toolName === 'annotate_plan';

      debugLog('tool_execution_start', {
        toolName,
        isBlockingPrompt,
        isPlanReviewTool,
        activeAskUserPrompts,
        snapshot: overlayDebugSnapshot(),
      });

      if (isPlanReviewTool) {
        beginPlanReview(ctx);
      }

      if (toolName === 'request_user_input') {
        debugToolState(
          ctx,
          `tool_execution_start · toolName=${toolName} · blocking=${isBlockingPrompt} · activeAskUserPrompts=${activeAskUserPrompts} · overlay=${overlay ? 'yes' : 'no'} · overlayStartPromise=${overlayStartPromise ? 'yes' : 'no'}`,
        );
      }
      if (
        !overlay &&
        !overlayStartPromise &&
        activePlanReviews === 0 &&
        !hasPendingPermissionRequest() &&
        !hasToolPermissionSuppression() &&
        !hasPendingAskUserPrompt() &&
        !isBlockingPrompt &&
        !isPlanReviewTool
      ) {
        void startOverlay(ctx);
      }

      if (isBlockingPrompt) {
        // Suppress any in-flight overlay creation while a blocking tool UI is active.
        overlaySuppressionToken++;
        activeAskUserPrompts++;
        if (overlay) {
          clearOverlay({
            restoreWorkingVisible: false,
            reason: 'blocking_tool_prompt',
          });
        }

        overlayRestartRequested = true;
        if (settings.soundEnabled && settings.ambientEnabled && agentRunning) {
          // When multiple prompts overlap (or one immediately follows another), force a fresh selection.
          const force = activeAskUserPrompts > 1;
          void audio.startAmbient({mode: 'permission', force});
        }
      }

      pulseOverlay('flash');
      const toolSuffix = toolName ? ` · ${toolName}` : '';
      showStatus(
        ctx,
        `OpenVibes on (${settings.selectedAnimation}) · casting${toolSuffix} · ${getMaskingLabel()}`,
      );
    },
  );

  (pi.on as any)(
    'tool_execution_end',
    async (event: unknown, ctx: ExtensionContext) => {
      if (!settings.enabled) return;
      audio.play('success', {throttleMs: 180});
      const toolName = extractToolName(event);
      const isBlockingPrompt = isBlockingTool(toolName);
      const isPlanReviewTool = toolName === 'annotate_plan';

      activeToolExecutionStack.pop();
      activeToolExecutionDepth = activeToolExecutionStack.length;

      const toolPermissionSuppressionCleared =
        permissionBlockingToolDepth !== undefined &&
        activeToolExecutionDepth < permissionBlockingToolDepth;

      if (toolPermissionSuppressionCleared) {
        permissionBlockingToolDepth = undefined;
        permissionBlockingToolName = undefined;
      }

      debugLog('tool_execution_end', {
        toolName,
        isBlockingPrompt,
        isPlanReviewTool,
        activeAskUserPrompts,
        snapshot: overlayDebugSnapshot(),
      });

      if (isPlanReviewTool) {
        endPlanReview(ctx);
      }

      if (toolName === 'request_user_input') {
        debugToolState(
          ctx,
          `tool_execution_end · toolName=${toolName} · blocking=${isBlockingPrompt} · activeAskUserPrompts=${activeAskUserPrompts} · overlay=${overlay ? 'yes' : 'no'}`,
        );
      }
      if (isBlockingPrompt) {
        activeAskUserPrompts = Math.max(0, activeAskUserPrompts - 1);
        if (activeAskUserPrompts === 0) {
          if (
            settings.soundEnabled &&
            settings.ambientEnabled &&
            agentRunning
          ) {
            void audio.startAmbient({mode: 'main', force: true});
          }

          requestOverlayRestart();
        }
      }

      if (toolPermissionSuppressionCleared && overlayRestartRequested) {
        requestOverlayRestart();
      }

      pulseOverlay('settle');
      const toolSuffix = toolName ? ` · ${toolName}` : '';
      showStatus(
        ctx,
        `OpenVibes on (${settings.selectedAnimation}) · settling${toolSuffix} · ${getMaskingLabel()}`,
      );
    },
  );

  pi.on('message_start', async (event) => {
    maskVisibleMessage(event.message, 'live');
  });

  pi.on('message_update', async (event) => {
    maskVisibleMessage(event.message, 'live');
  });

  pi.on('message_end', async (event, ctx) => {
    maskVisibleMessage(event.message, 'final');
    showStatus(ctx, formatStatusLine(agentRunning ? 'casting' : 'idle'));
  });

  pi.on('agent_end', async (_event, ctx) => {
    uiContext = ctx;
    agentRunning = false;
    activePermissionRequests.clear();
    activeAskUserPrompts = 0;
    activePlanReviews = 0;
    activeToolExecutionDepth = 0;
    activeToolExecutionStack = [];
    permissionBlockingToolDepth = undefined;
    permissionBlockingToolName = undefined;
    permissionUiSettleUntil = undefined;
    overlayRestartRequested = false;
    resetEscapeAbortState();
    clearCommandFeedbackTimer();
    if (permissionOverlayRestartTimer) {
      clearTimeout(permissionOverlayRestartTimer);
      permissionOverlayRestartTimer = undefined;
    }
    if (overlayPermissionCooldownRestartTimer) {
      clearTimeout(overlayPermissionCooldownRestartTimer);
      overlayPermissionCooldownRestartTimer = undefined;
    }
    closeCommandBurstOverlay(ctx);
    audio.play('settle');
    audio.stopAmbient();
    showStatus(
      ctx,
      settings.enabled
        ? formatStatusLine('idle')
        : `OpenVibes off · ${getMaskingLabel()}`,
    );
    closeOverlay(ctx, {reason: 'agent_end'});
  });

  pi.on('session_shutdown', async (_event, ctx) => {
    uiContext = ctx;
    agentRunning = false;
    activePermissionRequests.clear();
    activeAskUserPrompts = 0;
    activePlanReviews = 0;
    activeToolExecutionDepth = 0;
    activeToolExecutionStack = [];
    permissionBlockingToolDepth = undefined;
    permissionBlockingToolName = undefined;
    permissionUiSettleUntil = undefined;
    overlayRestartRequested = false;
    resetEscapeAbortState();
    clearCommandFeedbackTimer();
    if (permissionOverlayRestartTimer) {
      clearTimeout(permissionOverlayRestartTimer);
      permissionOverlayRestartTimer = undefined;
    }
    if (overlayPermissionCooldownRestartTimer) {
      clearTimeout(overlayPermissionCooldownRestartTimer);
      overlayPermissionCooldownRestartTimer = undefined;
    }
    closeCommandBurstOverlay(ctx);
    audio.play('shutdown');
    audio.dispose();
    detachTerminalInputListener();
    closeOverlay(ctx, {reason: 'session_shutdown'});
  });
}
