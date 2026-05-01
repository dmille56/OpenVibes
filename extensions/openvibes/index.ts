import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { MilliOverlayComponent } from "./milli-overlay.js";
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
type AssistantMessageLike = SessionMessage & { role: "assistant"; content: AssistantContent };

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
}

export default function (pi: ExtensionAPI) {
	let settings: OpenVibesSettings = { ...defaultOpenVibesSettings };
	let animations: OpenVibesAnimation[] = [];
	let overlay: OverlayState | undefined;
	let assistantRestoreQueue: MaskedAssistantDetails[] = [];

	const cloneContent = (content: AssistantContent): AssistantContent => structuredClone(content);

	const extractVisibleText = (content: AssistantContent, seen = new WeakSet<object>()): string => {
		if (typeof content === "string") return content;
		if (typeof content === "number" || typeof content === "boolean") return String(content);
		if (!content || typeof content !== "object") return "";
		if (Array.isArray(content)) return content.map((item) => extractVisibleText(item, seen)).join("");
		if (seen.has(content)) return "";
		seen.add(content);

		const record = content as Record<string, unknown>;
		if (typeof record.text === "string") return record.text;
		if (typeof record.content === "string") return record.content;
		if (Array.isArray(record.content)) return extractVisibleText(record.content, seen);
		if (Array.isArray(record.parts)) return extractVisibleText(record.parts, seen);
		if (Array.isArray(record.children)) return extractVisibleText(record.children, seen);
		return "";
	};

	const buildBinaryMask = (content: AssistantContent): string => {
		const text = extractVisibleText(content);
		return text
			.split(/(\r?\n)/)
			.map((chunk) => (chunk === "\n" || chunk === "\r\n" ? chunk : chunk.replace(/\S/g, () => (Math.random() < 0.5 ? "0" : "1"))))
			.join("");
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
			settings.selectedAnimation = animations.find((item) => item.name === "magic")?.name ?? animations[0]!.name;
			await persistSettings();
		}
	};

	const showStatus = (ctx: ExtensionContext, text: string): void => {
		if (ctx.hasUI) {
			ctx.ui.setStatus("openvibes", text);
		}
	};

	const closeOverlay = (ctx: ExtensionContext): void => {
		overlay?.close?.();
		overlay = undefined;
		if (ctx.hasUI) {
			ctx.ui.setWorkingVisible?.(true);
		}
	};

	const startOverlay = async (ctx: ExtensionContext): Promise<void> => {
		if (!ctx.hasUI || !settings.enabled || overlay) return;
		const animation = getSelectedAnimation();
		if (!animation) return;
		let player;
		try {
			player = await loadOpenVibesAnimation(animation.path);
		} catch (error) {
			ctx.ui.notify(`Failed to load OpenVibes animation ${animation.name}: ${error}`, "error");
			return;
		}
		if (!ctx.hasUI) return;

		let closeFn: (() => void) | undefined;
		overlay = { close: undefined, promise: undefined };
		overlay.promise = ctx.ui.custom(
			(tui, theme, _keybindings, done) => {
				closeFn = () => done(undefined);
				overlay!.close = closeFn;
				return new MilliOverlayComponent(tui, theme, player, `OpenVibes ${animation.name}`, "AI output is masked");
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
		ctx.ui.setWorkingVisible?.(false);
		void overlay.promise.finally(() => {
			if (overlay?.close === closeFn) {
				overlay = undefined;
			}
		});
	};

	const maskAssistantMessage = (message: AssistantMessageLike): void => {
		if (!settings.enabled) return;
		const maskedMessage = message as MaskedAssistantMessage;
		let originalContent = maskedMessage[maskedOriginalContentKey];
		if (originalContent === undefined) {
			originalContent = cloneContent(message.content);
			maskedMessage[maskedOriginalContentKey] = originalContent;
			const details = { originalContent };
			assistantRestoreQueue.push(details);
			pi.appendEntry(hiddenAssistantType, details);
		}
		message.content = [{ type: "text", text: buildBinaryMask(originalContent) }];
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
			if (message.role === "assistant") {
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
				const selected = getSelectedAnimation()?.name ?? "none";
				ctx.ui.notify(`OpenVibes ${settings.enabled ? "on" : "off"}, animation: ${selected}`, "info");
				return;
			}

			if (action === "toggle") {
				settings.enabled = !settings.enabled;
				await persistSettings();
				showStatus(ctx, settings.enabled ? `OpenVibes on (${settings.selectedAnimation})` : "OpenVibes off");
				ctx.ui.notify(`OpenVibes ${settings.enabled ? "enabled" : "disabled"}`, "info");
				return;
			}

			if (action === "on") {
				settings.enabled = true;
				await persistSettings();
				showStatus(ctx, `OpenVibes on (${settings.selectedAnimation})`);
				ctx.ui.notify("OpenVibes enabled", "info");
				return;
			}

			if (action === "off") {
				settings.enabled = false;
				await persistSettings();
				showStatus(ctx, "OpenVibes off");
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
				showStatus(ctx, `OpenVibes on (${settings.selectedAnimation})`);
				ctx.ui.notify(`Selected ${choice}`, "info");
				return;
			}

			ctx.ui.notify("Usage: /openvibes [status|on|off|toggle|list|select <name>]", "warning");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		settings = await readSettings();
		await refreshAnimations();
		restoreBranchQueue(ctx);
		showStatus(ctx, settings.enabled ? `OpenVibes on (${settings.selectedAnimation})` : "OpenVibes off");
	});

	pi.on("context", async (event) => {
		return { messages: unmaskContextMessages(event.messages) };
	});

	pi.on("agent_start", async (_event, ctx) => {
		if (settings.enabled) {
			await startOverlay(ctx);
		}
	});

	pi.on("message_start", async (event) => {
		if (!settings.enabled || event.message.role !== "assistant") return;
		maskAssistantMessage(event.message);
	});

	pi.on("message_update", async (event) => {
		if (!settings.enabled || event.message.role !== "assistant") return;
		maskAssistantMessage(event.message);
	});

	pi.on("message_end", async (event, ctx) => {
		if (!settings.enabled || event.message.role !== "assistant") return;
		maskAssistantMessage(event.message);
		showStatus(ctx, `OpenVibes on (${settings.selectedAnimation})`);
	});

	pi.on("agent_end", async (_event, ctx) => {
		closeOverlay(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		closeOverlay(ctx);
	});
}
