import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const OPENVIBES_EXTENSION_NAME = "openvibes";
export const OPENVIBES_MASK_CUSTOM_TYPE = "openvibes:assistant-mask";

export interface OpenVibesSettings {
	enabled: boolean;
	selectedAnimation: string;
}

export interface OpenVibesAnimation {
	name: string;
	path: string;
	source: "bundled" | "user";
}

export const defaultOpenVibesSettings: OpenVibesSettings = {
	enabled: true,
	selectedAnimation: "ai_genie",
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

export async function readSettings(): Promise<OpenVibesSettings> {
	try {
		const raw = await fs.readFile(getOpenVibesStatePath(), "utf8");
		const parsed = JSON.parse(raw) as Partial<OpenVibesSettings>;
		return {
			enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : defaultOpenVibesSettings.enabled,
			selectedAnimation:
				typeof parsed.selectedAnimation === "string" && parsed.selectedAnimation.trim()
					? parsed.selectedAnimation.trim()
					: defaultOpenVibesSettings.selectedAnimation,
		};
	} catch {
		return { ...defaultOpenVibesSettings };
	}
}

export async function writeSettings(settings: OpenVibesSettings): Promise<void> {
	await fs.mkdir(getOpenVibesConfigRoot(), { recursive: true });
	await fs.writeFile(getOpenVibesStatePath(), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}
