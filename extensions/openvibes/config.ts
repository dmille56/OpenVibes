import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const OPENVIBES_EXTENSION_NAME = "openvibes";
export const OPENVIBES_MASK_CUSTOM_TYPE = "openvibes:assistant-mask";

export interface OpenVibesSettings {
	enabled: boolean;
	maskAssistantOutput: boolean;
	selectedAnimation: string;
	soundEnabled: boolean;
	ambientEnabled: boolean;
	volume: number;
}

export interface OpenVibesAnimation {
	name: string;
	path: string;
	source: "bundled" | "user";
}

export const defaultOpenVibesSettings: OpenVibesSettings = {
	enabled: true,
	maskAssistantOutput: true,
	selectedAnimation: "ai_genie",
	soundEnabled: true,
	ambientEnabled: true,
	volume: 1.0,
};

export function getOpenVibesPackageRoot(): string {
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

export function getOpenVibesConfigRoot(): string {
	const baseDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
	return path.join(baseDir, OPENVIBES_EXTENSION_NAME);
}

export function getOpenVibesStatePath(): string {
	return path.join(getOpenVibesConfigRoot(), "state.json");
}

export function getOpenVibesAnimationDir(): string {
	return path.join(getOpenVibesConfigRoot(), "animations");
}

export function getOpenVibesSoundDir(): string {
	return path.join(getOpenVibesPackageRoot(), "sounds");
}

function normalizeVolume(volume: unknown): number {
	if (typeof volume !== "number" || !Number.isFinite(volume)) return defaultOpenVibesSettings.volume;
	return Math.min(1, Math.max(0, volume));
}

export async function readSettings(): Promise<OpenVibesSettings> {
	try {
		const raw = await fs.readFile(getOpenVibesStatePath(), "utf8");
		const parsed = JSON.parse(raw) as Partial<OpenVibesSettings>;
		return {
			enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : defaultOpenVibesSettings.enabled,
			maskAssistantOutput:
				typeof parsed.maskAssistantOutput === "boolean"
					? parsed.maskAssistantOutput
					: defaultOpenVibesSettings.maskAssistantOutput,
			selectedAnimation:
				typeof parsed.selectedAnimation === "string" && parsed.selectedAnimation.trim()
					? parsed.selectedAnimation.trim()
					: defaultOpenVibesSettings.selectedAnimation,
			soundEnabled: typeof parsed.soundEnabled === "boolean" ? parsed.soundEnabled : defaultOpenVibesSettings.soundEnabled,
			ambientEnabled: typeof parsed.ambientEnabled === "boolean" ? parsed.ambientEnabled : defaultOpenVibesSettings.ambientEnabled,
			volume: normalizeVolume(parsed.volume),
		};
	} catch {
		return { ...defaultOpenVibesSettings };
	}
}

export async function writeSettings(settings: OpenVibesSettings): Promise<void> {
	await fs.mkdir(getOpenVibesConfigRoot(), { recursive: true });
	await fs.writeFile(getOpenVibesStatePath(), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}
