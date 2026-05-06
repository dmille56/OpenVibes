import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
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
	const activePermissionRequests = new Set<string>();
	let overlayRestartRequested = false;
	let commandFeedbackTimer: ReturnType<typeof setTimeout> | undefined;
	let assistantRestoreQueue: MaskedAssistantDetails[] = [];
	let agentRunning = false;

	const cloneContent = (content: AssistantContent): AssistantContent => structuredClone(content);

	const setEditor = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI) return;
		ctx.ui.setEditorComponent(
			(tui, theme, keybindings) =>
				new WandTrailEditor(tui, theme, keybindings, () => settings.enabled, () => agentRunning, () => settings.selectedAnimation),
		);
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

	const maskStringValue = (key: string, value: string): string => {
		if (key === "text" || key === "thinking" || key === "output" || key === "result" || key === "partialArgs" || key === "command") {
			return buildBinaryMask(value);
		}
		return value;
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
			if (typeof value === "string") {
				maskedRecord[key] = maskStringValue(key, value);
				continue;
			}
			if (key === "content" || key === "parts" || key === "children") {
				maskedRecord[key] = maskVisibleContent(value, seen);
				continue;
			}
			if (value && typeof value === "object") {
				maskedRecord[key] = maskVisibleContent(value, seen);
				continue;
			}
			maskedRecord[key] = value;
		}

		return maskedRecord as AssistantContent;
	};

	const shouldMaskMessage = (message: SessionMessage): boolean => {
		return message.role === "assistant" || message.role === "toolResult" || message.role === "tool";
	};

	const getMaskingLabel = (): string => (settings.maskAssistantOutput ? "masking on" : "masking off");

	const formatStatusLine = (state: string): string => {
		return `OpenVibes ${settings.enabled ? "on" : "off"} (${settings.selectedAnimation}) · ${state} · ${getMaskingLabel()}`;
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
			`Animation: ${animationLabel}`,
			"",
			"Usage:",
			"  /openvibes on",
			"  /openvibes off",
			"  /openvibes toggle",
			"  /openvibes mask on",
			"  /openvibes mask off",
			"  /openvibes mask toggle",
			"  /openvibes list",
			"  /openvibes select <name>",
		].join("\n");
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
		if (!uiContext || !settings.enabled || !agentRunning || hasPendingPermissionRequest()) return;
		if (overlayStartPromise || overlay) return;
		overlayRestartRequested = false;
		void startOverlay(uiContext);
	};

	const hasPendingPermissionRequest = (): boolean => activePermissionRequests.size > 0;

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
			return;
		}

		if (event.state === "approved" || event.state === "denied") {
			activePermissionRequests.delete(requestId);
			requestOverlayRestart();
		}
	};

	const pulseOverlay = (mode: "flash" | "settle"): void => {
		(overlay?.component as { pulse?: (mode: "flash" | "settle") => void } | undefined)?.pulse?.(mode);
	};

	const startOverlay = async (ctx: ExtensionContext): Promise<void> => {
		if (!ctx.hasUI || !settings.enabled || overlay || overlayStartPromise) return;

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
			if (!ctx.hasUI || hasPendingPermissionRequest()) return;

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
			if (overlayRestartRequested && uiContext && settings.enabled && agentRunning && !hasPendingPermissionRequest() && !overlay) {
				overlayRestartRequested = false;
				void startOverlay(uiContext);
			}
		});

		await overlayStartPromise;
	};

	const maskVisibleMessage = (message: SessionMessage): void => {
		const maskedMessage = message as MaskedAssistantMessage;
		if (!settings.maskAssistantOutput || !shouldMaskMessage(message)) {
			const originalContent = maskedMessage[maskedOriginalContentKey];
			if (originalContent !== undefined) {
				message.content = originalContent;
			}
			return;
		}
		if (!settings.enabled) return;

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
				settings.enabled = !settings.enabled;
				await persistSettings();
				setEditor(ctx);
				void startCommandBurstOverlay(ctx, getBurstMessage("toggle"));
				pulseCommandFeedback(ctx, settings.enabled ? "OPENVIBES AWAKENS" : "OPENVIBES DIMS");
				pulseOverlay(settings.enabled ? "flash" : "settle");
				ctx.ui.notify(`OpenVibes ${settings.enabled ? "enabled" : "disabled"}`, "info");
				return;
			}

			if (action === "on") {
				settings.enabled = true;
				await persistSettings();
				setEditor(ctx);
				void startCommandBurstOverlay(ctx, getBurstMessage("on"));
				pulseCommandFeedback(ctx, "OPENVIBES AWAKENS");
				pulseOverlay("flash");
				ctx.ui.notify("OpenVibes enabled", "info");
				return;
			}

			if (action === "off") {
				settings.enabled = false;
				await persistSettings();
				setEditor(ctx);
				void startCommandBurstOverlay(ctx, getBurstMessage("off"));
				pulseCommandFeedback(ctx, "OPENVIBES DIMS");
				pulseOverlay("settle");
				ctx.ui.notify("OpenVibes disabled", "info");
				closeOverlay(ctx);
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

			ctx.ui.notify("Usage: /openvibes [status|on|off|toggle|mask <mode>|list|select <name>]", "warning");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		uiContext = ctx;
		activePermissionRequests.clear();
		overlayRestartRequested = false;
		clearCommandFeedbackTimer();
		closeCommandBurstOverlay(ctx);
		settings = await readSettings();
		agentRunning = false;
		await refreshAnimations();
		restoreBranchQueue(ctx);
		setEditor(ctx);
		showStatus(ctx, settings.enabled ? formatStatusLine("idle") : `OpenVibes off · ${getMaskingLabel()}`);
		triggerStartupBurst(ctx);
	});

	pi.events.on("pi-permission-system:permission-request", handlePermissionRequestEvent);

	(pi.events.on as any)("message", async (event: { message?: SessionMessage }) => {
		if (!event?.message) return;
		maskVisibleMessage(event.message);
	});

	(pi.on as any)("context", async (event: { messages: SessionMessage[] }) => {
		return { messages: unmaskContextMessages(event.messages) };
	});

	pi.on("agent_start", async (_event, ctx) => {
		uiContext = ctx;
		overlayRestartRequested = false;
		agentRunning = true;
		if (settings.enabled) {
			void startOverlay(ctx);
		}
		showStatus(ctx, settings.enabled ? formatStatusLine("casting") : `OpenVibes off · ${getMaskingLabel()}`);
	});

	(pi.on as any)("tool_execution_start", async (event: { tool?: { name?: string } }, ctx: ExtensionContext) => {
		uiContext = ctx;
		if (!settings.enabled) return;
		if (!overlay && !overlayStartPromise && !hasPendingPermissionRequest()) {
			void startOverlay(ctx);
		}
		pulseOverlay("flash");
		const toolName = event.tool?.name ? ` · ${event.tool.name}` : "";
		showStatus(ctx, `OpenVibes on (${settings.selectedAnimation}) · casting${toolName} · ${getMaskingLabel()}`);
	});

	(pi.on as any)("tool_execution_end", async (event: { tool?: { name?: string } }, ctx: ExtensionContext) => {
		if (!settings.enabled) return;
		pulseOverlay("settle");
		const toolName = event.tool?.name ? ` · ${event.tool.name}` : "";
		showStatus(ctx, `OpenVibes on (${settings.selectedAnimation}) · settling${toolName} · ${getMaskingLabel()}`);
	});

	pi.on("message_start", async (event) => {
		maskVisibleMessage(event.message);
	});

	pi.on("message_update", async (event) => {
		maskVisibleMessage(event.message);
	});

	pi.on("message_end", async (event, ctx) => {
		maskVisibleMessage(event.message);
		showStatus(ctx, formatStatusLine(agentRunning ? "casting" : "idle"));
	});

	pi.on("agent_end", async (_event, ctx) => {
		uiContext = ctx;
		agentRunning = false;
		activePermissionRequests.clear();
		overlayRestartRequested = false;
		clearCommandFeedbackTimer();
		closeCommandBurstOverlay(ctx);
		showStatus(ctx, settings.enabled ? formatStatusLine("idle") : `OpenVibes off · ${getMaskingLabel()}`);
		closeOverlay(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		uiContext = ctx;
		agentRunning = false;
		activePermissionRequests.clear();
		overlayRestartRequested = false;
		clearCommandFeedbackTimer();
		closeCommandBurstOverlay(ctx);
		closeOverlay(ctx);
	});
}
