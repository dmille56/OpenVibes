import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { getOpenVibesSoundDir } from "./config.js";

export type OpenVibesSoundName =
	| "wake"
	| "agent-start"
	| "tool-tick"
	| "success"
	| "settle"
	| "on"
	| "off"
	| "approve"
	| "deny"
	| "shutdown";

type AudioPlayerKind = "mpv" | "ffplay";

const SOUND_FILES: Record<OpenVibesSoundName, string> = {
	wake: "openvibes_wake.mp3",
	"agent-start": "openvibes_agentstart.mp3",
	"tool-tick": "openvibes_tooltick.mp3",
	success: "openvibes_success.mp3",
	settle: "openvibes_settle.mp3",
	on: "openvibes_on.mp3",
	off: "openvibes_off.mp3",
	approve: "openvibes_approve.mp3",
	deny: "openvibes_deny.mp3",
	shutdown: "openvibes_shutdown.mp3",
};

const AMBIENT_LOOP_FILES = [
	"openvibes_ambient_loop_1.mp3",
	"openvibes_ambient_loop_2.mp3",
	"openvibes_ambient_loop_3.mp3",
	"openvibes_ambient_loop_4.mp3",
] as const;

function clampVolume(volume: number): number {
	return Math.min(1, Math.max(0, volume));
}

function volumePercent(volume: number): number {
	return Math.max(0, Math.min(100, Math.round(clampVolume(volume) * 100)));
}

function findPlayer(): AudioPlayerKind | undefined {
	for (const candidate of ["mpv", "ffplay"] as const) {
		const probe = spawnSync(candidate, ["--version"], { stdio: "ignore" });
		if (!probe.error) return candidate;
	}
	return undefined;
}

export class OpenVibesAudioManager {
	private readonly player: AudioPlayerKind | undefined = findPlayer();
	private readonly activeProcesses = new Set<ChildProcess>();
	private readonly lastPlayedAt = new Map<OpenVibesSoundName, number>();
	private ambientProcess: ChildProcess | undefined;
	private ambientSound: string | undefined;
	private volume = 0;

	constructor(
		private readonly isSoundEnabled: () => boolean,
		private readonly isAmbientEnabled: () => boolean,
		private readonly getVolume: () => number,
	) {
		this.volume = clampVolume(this.getVolume());
	}

	private getSoundPath(fileName: string): string {
		return path.join(getOpenVibesSoundDir(), fileName);
	}

	private async fileExists(filePath: string): Promise<boolean> {
		try {
			await fs.access(filePath);
			return true;
		} catch {
			return false;
		}
	}

	private buildPlayerArgs(filePath: string, loop = false): string[] | undefined {
		this.volume = clampVolume(this.getVolume());
		const volume = volumePercent(this.volume);
		if (this.player === "mpv") {
			return [
				"--no-video",
				"--really-quiet",
				"--force-window=no",
				"--audio-display=no",
				`--volume=${volume}`,
				...(loop ? ["--loop-file=inf", "--keep-open=yes"] : ["--keep-open=no"]),
				filePath,
			];
		}
		if (this.player === "ffplay") {
			return [
				"-nodisp",
				"-loglevel",
				"quiet",
				`-volume`,
				String(volume),
				...(loop ? ["-loop", "0"] : ["-autoexit"]),
				filePath,
			];
		}
		return undefined;
	}

	private spawnPlayback(filePath: string, loop = false, track = loop): ChildProcess | undefined {
		if (!this.player) return undefined;
		const args = this.buildPlayerArgs(filePath, loop);
		if (!args) return undefined;
		const child = spawn(this.player, args, {
			detached: true,
			stdio: "ignore",
		});
		child.unref();
		if (track) {
			this.activeProcesses.add(child);
			child.once("exit", () => this.activeProcesses.delete(child));
			child.once("error", () => this.activeProcesses.delete(child));
		}
		return child;
	}

	private soundAllowed(): boolean {
		return this.isSoundEnabled();
	}

	play(name: OpenVibesSoundName, options?: { throttleMs?: number }): void {
		if (!this.soundAllowed()) return;
		const throttleMs = options?.throttleMs ?? 220;
		const now = Date.now();
		const lastPlayedAt = this.lastPlayedAt.get(name) ?? 0;
		if (now - lastPlayedAt < throttleMs) return;
		this.lastPlayedAt.set(name, now);

		void this.playFile(this.getSoundPath(SOUND_FILES[name]));
	}

	async playFile(filePath: string, loop = false): Promise<void> {
		if (!this.soundAllowed()) return;
		if (!(await this.fileExists(filePath))) return;
		this.spawnPlayback(filePath, loop, loop);
	}

	async startAmbient(preferredFile?: string): Promise<void> {
		if (!this.soundAllowed() || !this.isAmbientEnabled() || this.ambientProcess) return;
		const candidates = preferredFile ? [preferredFile] : [...AMBIENT_LOOP_FILES];
		const startIndex = preferredFile ? 0 : Math.floor(Math.random() * candidates.length);
		const orderedCandidates = preferredFile ? candidates : [...candidates.slice(startIndex), ...candidates.slice(0, startIndex)];
		for (const chosenFile of orderedCandidates) {
			const filePath = this.getSoundPath(chosenFile);
			if (!(await this.fileExists(filePath))) continue;
			const child = this.spawnPlayback(filePath, true, true);
			if (!child) continue;
			this.ambientProcess = child;
			this.ambientSound = chosenFile;
			child?.once("exit", () => {
				if (this.ambientProcess === child) {
					this.ambientProcess = undefined;
					this.ambientSound = undefined;
				}
			});
			child?.once("error", () => {
				if (this.ambientProcess === child) {
					this.ambientProcess = undefined;
					this.ambientSound = undefined;
				}
			});
			return;
		}
	}

	stopAmbient(): void {
		if (this.ambientProcess && !this.ambientProcess.killed) {
			this.ambientProcess.kill("SIGTERM");
		}
		this.ambientProcess = undefined;
		this.ambientSound = undefined;
	}

	setVolume(_volume: number): void {
		this.volume = clampVolume(_volume);
	}

	dispose(): void {
		this.stopAmbient();
		for (const process of this.activeProcesses) {
			if (!process.killed) process.kill("SIGTERM");
		}
		this.activeProcesses.clear();
	}

	getAmbientSound(): string | undefined {
		return this.ambientSound;
	}
}
