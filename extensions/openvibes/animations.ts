import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AsciiPlayer } from "@amansingh-afk/milli";
import { getOpenVibesAnimationDir, getOpenVibesPackageRoot, type OpenVibesAnimation } from "./config.js";

function animationNameFromFile(filePath: string): string {
	return path.basename(filePath, path.extname(filePath));
}

async function collectMilliFiles(root: string, source: "bundled" | "user"): Promise<OpenVibesAnimation[]> {
	const result: OpenVibesAnimation[] = [];

	async function walk(dir: string): Promise<void> {
		let entries;
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}

		for (const entry of entries) {
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(fullPath);
				continue;
			}
			if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".milli") continue;
			result.push({ name: animationNameFromFile(fullPath), path: fullPath, source });
		}
	}

	await walk(root);
	return result;
}

export async function discoverOpenVibesAnimations(): Promise<OpenVibesAnimation[]> {
	const bundledDir = path.join(getOpenVibesPackageRoot(), "images");
	const [bundled, user] = await Promise.all([
		collectMilliFiles(bundledDir, "bundled"),
		collectMilliFiles(getOpenVibesAnimationDir(), "user"),
	]);

	const merged = new Map<string, OpenVibesAnimation>();
	for (const animation of bundled) {
		merged.set(animation.name, animation);
	}
	for (const animation of user) {
		merged.set(animation.name, animation);
	}
	return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadOpenVibesAnimation(pathToMilli: string): Promise<AsciiPlayer> {
	return AsciiPlayer.load(pathToMilli);
}
