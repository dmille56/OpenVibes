import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { matchesKey, type Component } from "@mariozechner/pi-tui";
import { OpenVibesAudioManager } from "./audio.js";
import { CommandBurstOverlayComponent } from "./command-burst-overlay.js";
import { MilliOverlayComponent } from "./milli-overlay.js";
import { WandTrailEditor } from "./wand-editor.js";
import {
	defaultOpenVibesSettings,
	getOpenVibesAnimationDir,
	type OpenVibesAnimation,
	type OpenVibesSettings,
	OPENVIBES_MASK_CUSTOM_TYPE,
	readSettings,
	writeSettings,
} from "./config.js";
import { discoverOpenVibesAnimations, loadOpenVibesAnimation } from "./animations.js";

type AssistantContent = any;

type SessionMessage = { role: string; [key: string]: any };
type AssistantMessageLike = SessionMessage & { role: string; content: AssistantContent };
type PermissionRequestBusEvent = {
	source?: string;
	requestId?: string;
	state?: string;
};

const hiddenAssistantType = OPENVIBES_MASK_CUSTOM_TYPE;
const maskedOriginalContentKey = Symbol("openvibes.originalAssistantContent");

interface MaskedAssistantDetails {
	originalContent: AssistantContent;
}

type MaskedAssistantMessage = AssistantMessageLike & {
	[maskedOriginalContentKey]?: AssistantContent;
};

interface OverlayState {
	close: (() => void) | undefined;
	promise: Promise<unknown> | undefined;
	component: Component | undefined;
}

export default function (pi: ExtensionAPI) {
	let settings: OpenVibesSettings = { ...defaultOpenVibesSettings };
	let animations: OpenVibesAnimation[] = [];
	let overlay: OverlayState | undefined;
	let overlayStartPromise: Promise<void> | undefined;
	let commandBurstOverlay: OverlayState | undefined;
	let commandBurstStartPromise: Promise<void> | undefined;
	let uiContext: ExtensionContext | undefined;
	let terminalInputUnsubscribe: (() => void) | undefined;
	const activePermissionRequests = new Set<string>();
	let activeAskUserPrompts = 0;
	let overlayRestartRequested = false;
	let abortRequested = false;
	let escapeArmed = false;
	let lastEscapeAt = 0;
	let escapeHintTimer: ReturnType<typeof setTimeout> | undefined;
	let commandFeedbackTimer: ReturnType<typeof setTimeout> | undefined;
	let assistantRestoreQueue: MaskedAssistantDetails[] = [];
	let processedAssistantMessages = new WeakSet<object>();
	let agentRunning = false;
	const audio = new OpenVibesAudioManager(
		() => settings.soundEnabled,
		() => settings.ambientEnabled,
		() => settings.volume,
	);

	const cloneContent = (content: AssistantContent): AssistantContent => structuredClone(content);

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
		(overlay?.component as { setAbortHint?: (text: string | undefined) => void } | undefined)?.setAbortHint?.(undefined);
		escapeArmed = false;
		lastEscapeAt = 0;
		abortRequested = false;
	};

	const showAbortHint = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI) return;
		(overlay?.component as { setAbortHint?: (text: string | undefined) => void } | undefined)?.setAbortHint?.(
			"Press Escape again to abort",
		);
		if (escapeHintTimer) {
			clearTimeout(escapeHintTimer);
		}
		escapeHintTimer = setTimeout(() => {
			escapeHintTimer = undefined;
			(overlay?.component as { setAbortHint?: (text: string | undefined) => void } | undefined)?.setAbortHint?.(undefined);
		}, 1200);
	};

	const attachTerminalInputListener = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI || !ctx.ui.onTerminalInput) return;
		detachTerminalInputListener();
		terminalInputUnsubscribe = ctx.ui.onTerminalInput((data) => {
			if (!settings.enabled || !agentRunning || !matchesKey(data, "escape")) {
				return undefined;
			}

			const now = Date.now();
			const isDoubleEscape = escapeArmed && now - lastEscapeAt < 450;
			lastEscapeAt = now;

			if (!isDoubleEscape) {
				escapeArmed = true;
				showAbortHint(ctx);
				return { consume: true };
			}

			resetEscapeAbortState();
			abortRequested = true;
			overlayRestartRequested = false;
			closeOverlay(ctx);
			audio.stopAmbient();
			(overlay?.component as { setAbortHint?: (text: string | undefined) => void } | undefined)?.setAbortHint?.(undefined);
			ctx.abort();
			return { consume: true };
		});
	};

	const extractVisibleText = (content: AssistantContent, seen = new WeakSet<object>()): string => {
		if (typeof content === "string") return content;
		if (typeof content === "number" || typeof content === "boolean") return String(content);
		if (!content || typeof content !== "object") return "";
		if (Array.isArray(content)) return content.map((item) => extractVisibleText(item, seen)).join("");
		if (seen.has(content)) return "";
		seen.add(content);

		const record = content as Record<string, unknown>;
		const preferredKeys = ["text", "content", "parts", "children"];
		for (const key of preferredKeys) {
			const extracted = extractVisibleText(record[key], seen);
			if (extracted) return extracted;
		}

		for (const [key, value] of Object.entries(record)) {
			if (preferredKeys.includes(key)) continue;
			const extracted = extractVisibleText(value, seen);
			if (extracted) return extracted;
		}
		return "";
	};

	const buildBinaryMask = (content: AssistantContent): string => {
		const text = extractVisibleText(content);
		return text
			.split(/(\r?\n)/)
			.map((chunk) => (chunk === "\n" || chunk === "\r\n" ? chunk : chunk.replace(/\S/g, () => (Math.random() < 0.5 ? "0" : "1"))))
			.join("");
	};

	const isMaskedText = (text: string): boolean => text.length === 0 || /^[01\s]+$/.test(text);

	const isMaskedContent = (content: AssistantContent, seen = new WeakSet<object>()): boolean => {
		if (typeof content === "string") return isMaskedText(content);
		if (typeof content === "number" || typeof content === "boolean" || content === null || content === undefined) return true;
		if (typeof content !== "object") return true;
		if (Array.isArray(content)) {
			if (seen.has(content)) return true;
			seen.add(content);
			return content.every((item) => isMaskedContent(item, seen));
		}
		if (seen.has(content)) return true;
		seen.add(content);

		const record = content as Record<string, unknown>;
		const keysToCheck = ["text", "content", "parts", "children", "thinking", "output", "result"];
		let checkedAny = false;
		for (const key of keysToCheck) {
			if (!(key in record)) continue;
			checkedAny = true;
			if (!isMaskedContent(record[key], seen)) return false;
		}
		return checkedAny;
	};

	const maskVisibleContent = (content: AssistantContent, seen = new WeakMap<object, AssistantContent>()): AssistantContent => {
		if (typeof content === "string") return buildBinaryMask(content);
		if (typeof content === "number" || typeof content === "boolean" || content === null || content === undefined) return content;
		if (typeof content !== "object") return content;
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
			if (key === "text" || key === "thinking" || key === "output" || key === "result" || key === "content") {
				maskedRecord[key] = typeof value === "string" ? buildBinaryMask(value) : maskVisibleContent(value, seen);
				continue;
			}
			if (key === "parts" || key === "children") {
				maskedRecord[key] = maskVisibleContent(value, seen);
				continue;
			}
			maskedRecord[key] = value;
		}

		return maskedRecord as AssistantContent;
	};

	const shouldMaskMessage = (message: SessionMessage): boolean => {
		return message.role === "assistant";
	};

	const getMaskingLabel = (): string => (settings.maskAssistantOutput ? "masking on" : "masking off");

	const formatStatusLine = (state: string): string => {
		return `OpenVibes ${settings.enabled ? "on" : "off"} (${settings.selectedAnimation}) · ${state} · ${getMaskingLabel()}`;
	};

	const formatAudioStatus = (): string => {
		return `sound ${settings.soundEnabled ? "on" : "off"} · ambient ${settings.ambientEnabled ? "on" : "off"} · volume ${settings.volume.toFixed(2)}`;
	};

	const getSelectedAnimation = (): OpenVibesAnimation | undefined => {
		return animations.find((item) => item.name === settings.selectedAnimation) ?? animations[0];
	};

	const persistSettings = async (): Promise<void> => {
		await writeSettings(settings);
	};

	const refreshAnimations = async (): Promise<void> => {
		animations = await discoverOpenVibesAnimations();
		if (animations.length === 0) return;
		if (!animations.some((item) => item.name === settings.selectedAnimation)) {
			settings.selectedAnimation = animations.find((item) => item.name === "ai_genie")?.name ?? animations[0]!.name;
			await persistSettings();
		}
	};

	const showStatus = (ctx: ExtensionContext, text: string): void => {
		if (ctx.hasUI) {
			ctx.ui.setStatus("openvibes", text);
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
		ctx.ui.setStatus("openvibes", `✦ ${title} ✦`);
		commandFeedbackTimer = setTimeout(() => {
			commandFeedbackTimer = undefined;
			if (!uiContext) return;
			showStatus(uiContext, settings.enabled ? formatStatusLine(agentRunning ? "casting" : "idle") : `OpenVibes off · ${getMaskingLabel()}`);
		}, 1100);
	};

	const closeCommandBurstOverlay = (ctx: ExtensionContext): void => {
		commandBurstOverlay?.close?.();
		commandBurstOverlay = undefined;
	};

	const startCommandBurstOverlay = async (
		ctx: ExtensionContext,
		message: { title: string; subtitle: string; mode: "flash" | "settle" },
	): Promise<void> => {
		if (!ctx.hasUI || commandBurstOverlay || commandBurstStartPromise) return;

		commandBurstStartPromise = (async () => {
			let closeFn: (() => void) | undefined;
			commandBurstOverlay = { close: undefined, promise: undefined, component: undefined };
			try {
				commandBurstOverlay.promise = ctx.ui.custom(
					(tui, theme, _keybindings, done) => {
						closeFn = () => done(undefined);
						commandBurstOverlay!.close = closeFn;
						const component = new CommandBurstOverlayComponent(tui, message.title, message.subtitle, message.mode);
						commandBurstOverlay!.component = component;
						return component;
					},
					{
						overlay: true,
						overlayOptions: {
							anchor: "center",
							width: "100%",
							maxHeight: "100%",
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
			void burstPromise.catch(() => undefined).finally(() => {
				if (commandBurstOverlay?.close === closeFn) {
					commandBurstOverlay = undefined;
				}
			});
			setTimeout(() => closeFn?.(), 1050);
		})().finally(() => {
			commandBurstStartPromise = undefined;
		});

		await commandBurstStartPromise;
	};

	const getBurstMessage = (action: string): { title: string; subtitle: string; mode: "flash" | "settle" } => {
		if (action === "off") {
			return { title: "OPENVIBES DIMS", subtitle: "the veil closes", mode: "settle" };
		}
		if (action === "toggle" && !settings.enabled) {
			return { title: "OPENVIBES DIMS", subtitle: "the veil closes", mode: "settle" };
		}
		return { title: "OPENVIBES AWAKENS", subtitle: "the veil stirs", mode: "flash" };
	};

	const triggerStartupBurst = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI || !settings.enabled) return;
		void startCommandBurstOverlay(ctx, getBurstMessage("on"));
	};

	const formatStatusHelp = (): string => {
		const selected = getSelectedAnimation();
		const animationLabel = selected ? `${selected.name} (${selected.source === "user" ? "user" : "bundled"})` : "none";
		return [
			`OpenVibes: ${settings.enabled ? "on" : "off"}`,
			`Masking: ${settings.maskAssistantOutput ? "on" : "off"}`,
			`Audio: ${formatAudioStatus()}`,
			`Animation: ${animationLabel}`,
			"",
			"Usage:",
			"  /openvibes on",
			"  /openvibes off",
			"  /openvibes toggle",
			"  /openvibes mask on",
			"  /openvibes mask off",
			"  /openvibes mask toggle",
			"  /openvibes sound [status|on|off|toggle]",
			"  /openvibes ambient [status|on|off|toggle]",
			"  /openvibes volume <0-1>",
			"  /openvibes list",
			"  /openvibes select <name>",
		].join("\n");
	};

	const parseVolume = (value: string): number | undefined => {
		const parsed = Number(value);
		if (!Number.isFinite(parsed)) return undefined;
		return Math.max(0, Math.min(1, parsed));
	};

	const closeOverlay = (ctx: ExtensionContext): void => {
		overlay?.close?.();
		overlay = undefined;
		if (ctx.hasUI) {
			ctx.ui.setWorkingVisible?.(true);
		}
	};

	const clearOverlay = (): void => {
		overlay?.close?.();
		overlay = undefined;
		uiContext?.ui.setWorkingVisible?.(true);
	};

	const requestOverlayRestart = (): void => {
		overlayRestartRequested = true;
		if (!uiContext || abortRequested || !settings.enabled || !agentRunning || hasPendingPermissionRequest() || hasPendingAskUserPrompt()) return;
		if (overlayStartPromise || overlay) return;
		overlayRestartRequested = false;
		void startOverlay(uiContext);
	};

	const hasPendingPermissionRequest = (): boolean => activePermissionRequests.size > 0;
	const hasPendingAskUserPrompt = (): boolean => activeAskUserPrompts > 0;

	const handlePermissionRequestEvent = (data: unknown): void => {
		if (!data || typeof data !== "object") return;
		const event = data as PermissionRequestBusEvent;
		const requestId = event.requestId?.trim();
		if (!requestId) return;

		if (event.state === "waiting") {
			activePermissionRequests.add(requestId);
			if (overlay) {
				clearOverlay();
			}
			overlayRestartRequested = true;

			if (settings.enabled && settings.soundEnabled && settings.ambientEnabled && agentRunning) {
				// When multiple permission requests overlap, force a fresh permission-ambient selection
				// so the audio stays meaningfully distinct.
				const force = activePermissionRequests.size > 1;
				void audio.startAmbient({ mode: "permission", force });
			}
			return;
		}

		if (event.state === "approved" || event.state === "denied") {
			activePermissionRequests.delete(requestId);
			if (
				activePermissionRequests.size === 0 &&
				settings.enabled &&
				settings.soundEnabled &&
				settings.ambientEnabled &&
				agentRunning
			) {
				void audio.startAmbient({ mode: "main", force: true });
			}
			requestOverlayRestart();
		}
	};

	const pulseOverlay = (mode: "flash" | "settle"): void => {
		(overlay?.component as { pulse?: (mode: "flash" | "settle") => void } | undefined)?.pulse?.(mode);
	};

	const startOverlay = async (ctx: ExtensionContext): Promise<void> => {
		if (!ctx.hasUI || abortRequested || !settings.enabled || overlay || overlayStartPromise) return;

		overlayStartPromise = (async () => {
			const animation = getSelectedAnimation();
			if (!animation) return;
			let player;
			try {
				player = await loadOpenVibesAnimation(animation.path);
			} catch (error) {
				ctx.ui.notify(`Failed to load OpenVibes animation ${animation.name}: ${error}`, "error");
				return;
			}
			if (!ctx.hasUI || hasPendingPermissionRequest() || hasPendingAskUserPrompt()) return;

			let closeFn: (() => void) | undefined;
			overlay = { close: undefined, promise: undefined, component: undefined };
			try {
				overlay.promise = ctx.ui.custom(
					(tui, theme, _keybindings, done) => {
						closeFn = () => done(undefined);
						overlay!.close = closeFn;
						const component = new MilliOverlayComponent(tui, player);
						overlay!.component = component;
						return component;
					},
					{
						overlay: true,
						overlayOptions: {
							anchor: "center",
							width: "100%",
							maxHeight: "100%",
							margin: 0,
						},
					},
				);
			} catch (error) {
				overlay = undefined;
				throw error;
			}
			ctx.ui.setWorkingVisible?.(false);
			const overlayPromise = overlay.promise;
			if (!overlayPromise) return;
			void overlayPromise.catch(() => undefined).finally(() => {
				if (overlay?.close === closeFn) {
					overlay = undefined;
				}
			});
		})().finally(() => {
			overlayStartPromise = undefined;
			if (
				overlayRestartRequested &&
				uiContext &&
				settings.enabled &&
				agentRunning &&
				!hasPendingPermissionRequest() &&
				!hasPendingAskUserPrompt() &&
				!overlay
			) {
				overlayRestartRequested = false;
				void startOverlay(uiContext);
			}
		});

		await overlayStartPromise;
	};

	const syncAmbientAudio = async (): Promise<void> => {
		if (settings.enabled && settings.soundEnabled && settings.ambientEnabled && agentRunning) {
			await audio.startAmbient({ mode: hasPendingPermissionRequest() || hasPendingAskUserPrompt() ? "permission" : "main" });
			return;
		}
		audio.stopAmbient();
	};

	const maskVisibleMessage = (message: SessionMessage, phase: "live" | "final" = "live"): void => {
		const maskedMessage = message as MaskedAssistantMessage;
		if (!settings.maskAssistantOutput || !shouldMaskMessage(message)) {
			const originalContent = maskedMessage[maskedOriginalContentKey];
			if (originalContent !== undefined) {
				message.content = originalContent;
			}
			return;
		}
		if (!settings.enabled) return;
		if (phase === "live") return;
		if (typeof message !== "object" || message === null) return;
		if (processedAssistantMessages.has(message)) return;
		processedAssistantMessages.add(message);
		if (isMaskedContent(message.content)) return;

		let originalContent = maskedMessage[maskedOriginalContentKey];
		if (originalContent === undefined) {
			originalContent = cloneContent(message.content);
			maskedMessage[maskedOriginalContentKey] = originalContent;
			const details = { originalContent };
			assistantRestoreQueue.push(details);
			pi.appendEntry(hiddenAssistantType, details);
		}
		message.content = maskVisibleContent(originalContent);
	};

	const restoreBranchQueue = (ctx: ExtensionContext): void => {
		assistantRestoreQueue = [];
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === hiddenAssistantType) {
				const details = entry.data as MaskedAssistantDetails | undefined;
				if (details?.originalContent !== undefined) {
					assistantRestoreQueue.push(details);
				}
			}
		}
	};

	const unmaskContextMessages = (messages: SessionMessage[]): SessionMessage[] => {
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

	pi.registerCommand("openvibes", {
		description: "Toggle OpenVibes and choose milli animations",
		handler: async (args, ctx: ExtensionCommandContext) => {
			const [action, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const animationName = rest.join(" ").trim();

			if (!action || action === "status") {
				ctx.ui.notify(formatStatusHelp(), "info");
				return;
			}

			if (action === "toggle") {
				const nextEnabled = !settings.enabled;
				audio.play(nextEnabled ? "on" : "off");
				settings.enabled = !settings.enabled;
				await persistSettings();
				setEditor(ctx);
				void startCommandBurstOverlay(ctx, getBurstMessage("toggle"));
				pulseCommandFeedback(ctx, settings.enabled ? "OPENVIBES AWAKENS" : "OPENVIBES DIMS");
				pulseOverlay(settings.enabled ? "flash" : "settle");
				if (!settings.enabled) audio.stopAmbient();
				else void syncAmbientAudio();
				ctx.ui.notify(`OpenVibes ${settings.enabled ? "enabled" : "disabled"}`, "info");
				return;
			}

			if (action === "on") {
				audio.play("on");
				settings.enabled = true;
				await persistSettings();
				setEditor(ctx);
				void startCommandBurstOverlay(ctx, getBurstMessage("on"));
				pulseCommandFeedback(ctx, "OPENVIBES AWAKENS");
				pulseOverlay("flash");
				void syncAmbientAudio();
				ctx.ui.notify("OpenVibes enabled", "info");
				return;
			}

			if (action === "off") {
				audio.play("off");
				settings.enabled = false;
				await persistSettings();
				setEditor(ctx);
				void startCommandBurstOverlay(ctx, getBurstMessage("off"));
				pulseCommandFeedback(ctx, "OPENVIBES DIMS");
				pulseOverlay("settle");
				ctx.ui.notify("OpenVibes disabled", "info");
				audio.stopAmbient();
				closeOverlay(ctx);
				return;
			}

			if (action === "sound") {
				const [mode] = rest;
				if (!mode || mode === "status") {
					ctx.ui.notify(`Sound is ${settings.soundEnabled ? "on" : "off"} (${formatAudioStatus()})`, "info");
					return;
				}
				if (mode === "toggle") {
					settings.soundEnabled = !settings.soundEnabled;
				} else if (mode === "on") {
					settings.soundEnabled = true;
				} else if (mode === "off") {
					settings.soundEnabled = false;
				} else {
					ctx.ui.notify("Usage: /openvibes sound [status|on|off|toggle]", "warning");
					return;
				}
				await persistSettings();
				if (!settings.soundEnabled) audio.stopAmbient();
				else void syncAmbientAudio();
				ctx.ui.notify(`Sound ${settings.soundEnabled ? "enabled" : "disabled"}`, "info");
				return;
			}

			if (action === "ambient") {
				const [mode] = rest;
				if (!mode || mode === "status") {
					ctx.ui.notify(`Ambient is ${settings.ambientEnabled ? "on" : "off"}`, "info");
					return;
				}
				if (mode === "toggle") {
					settings.ambientEnabled = !settings.ambientEnabled;
				} else if (mode === "on") {
					settings.ambientEnabled = true;
				} else if (mode === "off") {
					settings.ambientEnabled = false;
				} else {
					ctx.ui.notify("Usage: /openvibes ambient [status|on|off|toggle]", "warning");
					return;
				}
				await persistSettings();
				if (!settings.ambientEnabled) audio.stopAmbient();
				else void syncAmbientAudio();
				ctx.ui.notify(`Ambient ${settings.ambientEnabled ? "enabled" : "disabled"}`, "info");
				return;
			}

			if (action === "volume") {
				const [value] = rest;
				if (!value) {
					ctx.ui.notify(`Usage: /openvibes volume <0-1> (current ${settings.volume.toFixed(2)})`, "warning");
					return;
				}
				const volume = parseVolume(value);
				if (volume === undefined) {
					ctx.ui.notify("Usage: /openvibes volume <0-1>", "warning");
					return;
				}
				settings.volume = volume;
				audio.setVolume(volume);
				await persistSettings();
				ctx.ui.notify(`Volume set to ${settings.volume.toFixed(2)}`, "info");
				return;
			}

			if (action === "list") {
				await refreshAnimations();
				const items = animations.map((item) => `${item.source === "user" ? "user" : "bundled"}: ${item.name}`);
				ctx.ui.notify(items.length > 0 ? items.join(", ") : `No .milli files found in ${getOpenVibesAnimationDir()}`, "info");
				return;
			}

			if (action === "select") {
				await refreshAnimations();
				let choice = animationName;
				if (!choice) {
					const selected = await ctx.ui.select("Choose OpenVibes animation", animations.map((item) => item.name));
					if (!selected) return;
					choice = selected;
				}
				if (!animations.some((item) => item.name === choice)) {
					ctx.ui.notify(`Unknown animation: ${choice}`, "error");
					return;
				}
				settings.selectedAnimation = choice;
				await persistSettings();
				showStatus(ctx, formatStatusLine(agentRunning ? "casting" : "idle"));
				ctx.ui.notify(`Selected ${choice}`, "info");
				return;
			}

			if (action === "mask") {
				const [mode] = rest;
				if (!mode || mode === "status") {
					ctx.ui.notify(`Masking is ${settings.maskAssistantOutput ? "on" : "off"}`, "info");
					return;
				}
				if (mode === "toggle") {
					settings.maskAssistantOutput = !settings.maskAssistantOutput;
				} else if (mode === "on") {
					settings.maskAssistantOutput = true;
				} else if (mode === "off") {
					settings.maskAssistantOutput = false;
				} else {
					ctx.ui.notify("Usage: /openvibes mask [status|on|off|toggle]", "warning");
					return;
				}
				await persistSettings();
				showStatus(ctx, settings.enabled ? formatStatusLine(agentRunning ? "casting" : "idle") : `OpenVibes off · ${getMaskingLabel()}`);
				ctx.ui.notify(`Masking ${settings.maskAssistantOutput ? "enabled" : "disabled"}`, "info");
				return;
			}

			ctx.ui.notify("Usage: /openvibes [status|on|off|toggle|mask <mode>|sound <mode>|ambient <mode>|volume <0-1>|list|select <name>]", "warning");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		uiContext = ctx;
		activePermissionRequests.clear();
		activeAskUserPrompts = 0;
		overlayRestartRequested = false;
		resetEscapeAbortState();
		clearCommandFeedbackTimer();
		closeCommandBurstOverlay(ctx);
		processedAssistantMessages = new WeakSet<object>();
		settings = await readSettings();
		agentRunning = false;
		await refreshAnimations();
		restoreBranchQueue(ctx);
		setEditor(ctx);
		attachTerminalInputListener(ctx);
		showStatus(ctx, settings.enabled ? formatStatusLine("idle") : `OpenVibes off · ${getMaskingLabel()}`);
		audio.play("wake");
		triggerStartupBurst(ctx);
	});

	pi.events.on("pi-permission-system:permission-request", handlePermissionRequestEvent);

	(pi.on as any)("context", async (event: { messages: SessionMessage[] }) => {
		return { messages: unmaskContextMessages(event.messages) };
	});

	pi.on("agent_start", async (_event, ctx) => {
		uiContext = ctx;
		overlayRestartRequested = false;
		activeAskUserPrompts = 0;
		resetEscapeAbortState();
		agentRunning = true;
		if (settings.enabled) {
			void startOverlay(ctx);
		}
		audio.play("agent-start");
		void syncAmbientAudio();
		showStatus(ctx, settings.enabled ? formatStatusLine("casting") : `OpenVibes off · ${getMaskingLabel()}`);
	});

	(pi.on as any)("tool_execution_start", async (event: { tool?: { name?: string } }, ctx: ExtensionContext) => {
		uiContext = ctx;
		if (!settings.enabled) return;
		audio.play("tool-tick", { throttleMs: 180 });
		const toolName = event.tool?.name;
		const isAskUser = toolName === "ask_user";
		const isAskUserQuestion = toolName === "ask_user_question";
		const isBlockingPrompt = isAskUser || isAskUserQuestion;
		if (!overlay && !overlayStartPromise && !hasPendingPermissionRequest() && !hasPendingAskUserPrompt() && !isBlockingPrompt) {
			void startOverlay(ctx);
		}
		if (isBlockingPrompt) {
			activeAskUserPrompts++;
			if (overlay) {
				clearOverlay();
			}
			overlayRestartRequested = true;
			if (settings.soundEnabled && settings.ambientEnabled && agentRunning) {
				// When multiple prompts overlap (or one immediately follows another), force a fresh selection.
				const force = activeAskUserPrompts > 1;
				void audio.startAmbient({ mode: "permission", force });
			}
		}
		pulseOverlay("flash");
		const toolSuffix = toolName ? ` · ${toolName}` : "";
		showStatus(ctx, `OpenVibes on (${settings.selectedAnimation}) · casting${toolSuffix} · ${getMaskingLabel()}`);
	});

	(pi.on as any)("tool_execution_end", async (event: { tool?: { name?: string } }, ctx: ExtensionContext) => {
		if (!settings.enabled) return;
		audio.play("success", { throttleMs: 180 });
		const toolName = event.tool?.name;
		const isAskUser = toolName === "ask_user";
		const isAskUserQuestion = toolName === "ask_user_question";
		const isBlockingPrompt = isAskUser || isAskUserQuestion;
		if (isBlockingPrompt) {
			activeAskUserPrompts = Math.max(0, activeAskUserPrompts - 1);
			if (activeAskUserPrompts === 0) {
				if (settings.soundEnabled && settings.ambientEnabled && agentRunning) {
					void audio.startAmbient({ mode: "main", force: true });
				}
				requestOverlayRestart();
			}
		}
		pulseOverlay("settle");
		const toolSuffix = toolName ? ` · ${toolName}` : "";
		showStatus(ctx, `OpenVibes on (${settings.selectedAnimation}) · settling${toolSuffix} · ${getMaskingLabel()}`);
	});

	pi.on("message_start", async (event) => {
		maskVisibleMessage(event.message, "live");
	});

	pi.on("message_update", async (event) => {
		maskVisibleMessage(event.message, "live");
	});

	pi.on("message_end", async (event, ctx) => {
		maskVisibleMessage(event.message, "final");
		showStatus(ctx, formatStatusLine(agentRunning ? "casting" : "idle"));
	});

	pi.on("agent_end", async (_event, ctx) => {
		uiContext = ctx;
		agentRunning = false;
		activePermissionRequests.clear();
		activeAskUserPrompts = 0;
		overlayRestartRequested = false;
		resetEscapeAbortState();
		clearCommandFeedbackTimer();
		closeCommandBurstOverlay(ctx);
		audio.play("settle");
		audio.stopAmbient();
		showStatus(ctx, settings.enabled ? formatStatusLine("idle") : `OpenVibes off · ${getMaskingLabel()}`);
		closeOverlay(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		uiContext = ctx;
		agentRunning = false;
		activePermissionRequests.clear();
		activeAskUserPrompts = 0;
		overlayRestartRequested = false;
		resetEscapeAbortState();
		clearCommandFeedbackTimer();
		closeCommandBurstOverlay(ctx);
		audio.play("shutdown");
		audio.dispose();
		detachTerminalInputListener();
		closeOverlay(ctx);
	});
}
