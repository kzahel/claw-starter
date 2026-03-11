#!/usr/bin/env tsx

/**
 * Smart cron scheduler for assistant instances.
 *
 * Reads schedules from config.yaml, fires Claude Code sessions at the right
 * times, and tracks run state. Supports multiple executors (Yep Anywhere
 * server API, or Claude CLI directly).
 *
 * Also polls Telegram for incoming messages and spawns sessions for them.
 *
 * Usage:
 *   scheduler --instance ~/assistant-data/assistants/my-assistant
 *   scheduler --instance ~/assistant-data/assistants/my-assistant --executor claude
 *   scheduler --instance ~/assistant-data/assistants/my-assistant --run-now morning-digest
 */

import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import cronParser from "cron-parser";
import { parse as parseYaml } from "yaml";
import {
	type PermissionRules,
	type SessionExecutor,
	createClaudeCliExecutor,
	createYepAnywhereExecutor,
} from "./session-executor.js";
import { loadEnv } from "./utils.js";

// --- Types ---

interface ScheduleRunState {
	lastRunAt?: string;
	lastStatus?: "ok" | "error" | "skipped";
	consecutiveErrors: number;
}

/** Runtime state for all schedules, keyed by schedule name. Stored in state/scheduler.json. */
type SchedulerState = Record<string, ScheduleRunState>;

interface SkillRef {
	skill: string;
	args?: Record<string, unknown>;
}

interface Schedule {
	name: string;
	cron: string;
	skills: SkillRef[];
	output?: string | string[];
	prompt?: string;
	enabled?: boolean;
	maxConsecutiveErrors?: number;
}

interface Config {
	name: string;
	executor?: string;
	skills?: Record<string, Record<string, unknown>>;
	schedules?: Schedule[];
}

interface ActiveSession {
	scheduleName: string;
	sessionId: string;
	startedAt: number;
}

// --- CLI args ---

const { values: args } = parseArgs({
	options: {
		instance: { type: "string" },
		port: { type: "string", default: "3400" },
		executor: { type: "string" },
		"run-now": { type: "string" },
	},
	strict: false,
});

const instanceDir = resolve(
	typeof args.instance === "string" ? args.instance : "",
);
if (!instanceDir || !existsSync(join(instanceDir, "config.yaml"))) {
	console.error(
		"Usage: scheduler --instance <dir> [--executor yep|claude] [--port 3400] [--run-now <name>]",
	);
	console.error("  <dir> must contain a config.yaml");
	process.exit(1);
}

// --- Helpers ---

function log(msg: string) {
	console.log(`[${new Date().toISOString()}] ${msg}`);
}

function toProjectId(path: string): string {
	return Buffer.from(path).toString("base64url");
}

function loadConfig(): Config {
	const raw = readFileSync(join(instanceDir, "config.yaml"), "utf-8");
	return parseYaml(raw) as Config;
}

const stateFile = join(instanceDir, "state", "scheduler.json");

function loadState(): SchedulerState {
	try {
		return JSON.parse(readFileSync(stateFile, "utf-8")) as SchedulerState;
	} catch {
		return {};
	}
}

function saveState(state: SchedulerState) {
	const dir = join(instanceDir, "state");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n");
}

function appendActivity(entry: Record<string, unknown>) {
	const logDir = join(instanceDir, "memory");
	if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
	appendFileSync(
		join(logDir, "activity-log.jsonl"),
		`${JSON.stringify(entry)}\n`,
	);
}

function buildSessionMessage(schedule: Schedule, _config: Config): string {
	const skillLines = schedule.skills
		.map((s) => {
			let line = `- ${s.skill}`;
			if (s.args) line += ` (args: ${JSON.stringify(s.args)})`;
			return line;
		})
		.join("\n");

	const outputs = Array.isArray(schedule.output)
		? schedule.output
		: schedule.output
			? [schedule.output]
			: [];
	const outputLine = outputs.length > 0
		? `\nDeliver the combined output via each of these channels: ${outputs.join(", ")}. Send to every listed channel.`
		+ `\nWhen sending to telegram, always start the message with a header line like "📋 <Schedule Name>" (e.g. "📋 Morning Digest") followed by a blank line, so it's clearly distinguishable from regular conversation messages.`
		: "";

	const instructions = schedule.prompt ?? "When done, summarize what you did.";

	return [
		`ASSISTANT_TRIGGER=cron:${schedule.name}`,
		"",
		`Run the "${schedule.name}" schedule. Execute these skills in order:`,
		skillLines,
		outputLine,
		"",
		instructions,
		"",
		"Execute autonomously. Do not ask questions. Do not produce unnecessary output.",
	].join("\n");
}

// --- Executor setup ---

function createExecutor(config: Config): SessionExecutor {
	const executorType = args.executor ?? config.executor ?? "claude";

	if (executorType === "claude") {
		log("Using Claude CLI executor");
		return createClaudeCliExecutor({ cwd: instanceDir });
	}

	const port = Number(args.port) || 3400;
	const baseUrl = `http://127.0.0.1:${port}`;
	const projectId = toProjectId(instanceDir);
	log(`Using Yep Anywhere executor (${baseUrl})`);
	return createYepAnywhereExecutor({ baseUrl, projectId });
}

const initialConfig = loadConfig();
const executor = createExecutor(initialConfig);

// --- Cron permission rules ---
// Cron sessions process untrusted content (scraped web pages, Reddit, HN).
// Deny patterns that could indicate prompt injection exploitation.
// Unmatched commands fall through to permissionMode behavior.
const CRON_PERMISSIONS: PermissionRules = {
	deny: [
		"Bash(*| bash*)",
		"Bash(*| sh*)",
		"Bash(*| zsh*)",
		"Bash(curl *)",
		"Bash(wget *)",
		"Bash(pip install *)",
		"Bash(pip3 install *)",
		"Bash(npm install *)",
		"Bash(npx -y *)",
		"Bash(ssh *)",
		"Bash(scp *)",
		"Bash(nc *)",
		"Bash(ncat *)",
		"Bash(python* -c *)",
		"Bash(node -e *)",
		"Bash(eval *)",
		"Bash(exec *)",
		"Bash(*crontab*)",
		"Bash(*~/.bashrc*)",
		"Bash(*~/.profile*)",
		"Bash(*~/.ssh/*)",
		"Bash(*authorized_keys*)",
		"Bash(chmod +s *)",
		"Bash(base64 -d*| *)",
	],
};

// --- Session management ---

const activeSessions = new Map<string, ActiveSession>();

async function fireSchedule(
	schedule: Schedule,
	config: Config,
): Promise<boolean> {
	const message = buildSessionMessage(schedule, config);

	log(`Firing schedule: ${schedule.name}`);

	try {
		const result = await executor.start(message, {
			cwd: instanceDir,
			permissions: CRON_PERMISSIONS,
		});

		if (result.status === "started") {
			log(`  Session started: ${result.sessionId}`);
			activeSessions.set(schedule.name, {
				scheduleName: schedule.name,
				sessionId: result.sessionId,
				startedAt: Date.now(),
			});
			return true;
		}

		log(`  Queued: ${result.sessionId}`);
		return true;
	} catch (err) {
		log(`  Error: ${(err as Error).message}`);
		return false;
	}
}

async function pollSession(
	active: ActiveSession,
): Promise<"running" | "done" | "error"> {
	const result = await executor.poll(active.sessionId);
	return result.status;
}

function updateState(
	scheduleName: string,
	status: "ok" | "error",
	durationMs: number,
) {
	const state = loadState();
	const run = state[scheduleName] ?? { consecutiveErrors: 0 };

	run.lastRunAt = new Date().toISOString();
	run.lastStatus = status;

	if (status === "error") {
		run.consecutiveErrors++;
	} else {
		run.consecutiveErrors = 0;
	}

	state[scheduleName] = run;
	saveState(state);

	appendActivity({
		ts: new Date().toISOString(),
		trigger: "schedule",
		source: scheduleName,
		skill: "*",
		status,
		durationMs,
	});
}

// --- Channel setup ---

import type { ChannelTransport, ChannelUser } from "./channel.js";
import { createTelegramTransport } from "./channels/telegram.js";
import type { TranscriptionConfig } from "./transcription.js";

const instanceEnv = loadEnv(instanceDir);

function loadTelegramUsers(): ChannelUser[] {
	const config = loadConfig();
	const tgConfig = config.skills?.telegram as Record<string, unknown> | undefined;
	if (!tgConfig) return [];

	// Support both old single chatId and new allowedUsers list
	const allowedUsers = tgConfig.allowedUsers as ChannelUser[] | undefined;
	if (allowedUsers) return allowedUsers;

	const chatId = (tgConfig.chatId as string) ?? instanceEnv.TELEGRAM_CHAT_ID ?? process.env.TELEGRAM_CHAT_ID;
	if (chatId) return [{ chatId, name: "User" }];
	return [];
}

function buildTranscriptionConfig(): TranscriptionConfig {
	const config = loadConfig();
	const transcription = (config.skills?.transcription ?? {}) as Record<string, string>;
	return {
		backend: transcription.backend ?? "auto",
		pythonPath: transcription.pythonPath,
		groqApiKey: instanceEnv.GROQ_API_KEY ?? process.env.GROQ_API_KEY,
		openaiApiKey: instanceEnv.OPENAI_API_KEY ?? process.env.OPENAI_API_KEY,
	};
}

function createChannels(): ChannelTransport[] {
	const channels: ChannelTransport[] = [];

	// Telegram
	const telegramToken = instanceEnv.TELEGRAM_BOT_TOKEN ?? process.env.TELEGRAM_BOT_TOKEN;
	const telegramUsers = loadTelegramUsers();
	if (telegramToken && telegramUsers.length > 0) {
		const transport = createTelegramTransport({
			token: telegramToken,
			users: telegramUsers,
			instanceDir,
			ctx: { instanceDir, executor, log, appendActivity },
			transcriptionConfig: buildTranscriptionConfig(),
		});
		if (transport.enabled) {
			channels.push(transport);
			log(`Telegram channel enabled (${telegramUsers.length} user(s): ${telegramUsers.map((u) => u.name).join(", ")})`);
		}
	}

	return channels;
}

// --- Cron logic ---

interface ScheduleTracker {
	schedule: Schedule;
	nextFire: Date;
	advance(): void;
}

function initTrackers(schedules: Schedule[]): ScheduleTracker[] {
	return schedules
		.filter((s) => s.enabled !== false)
		.map((s) => {
			const interval = cronParser.parseExpression(s.cron, {
				tz: "Europe/Zurich",
				currentDate: new Date(),
			});
			return {
				schedule: s,
				nextFire: interval.next().toDate(),
				advance() {
					this.nextFire = interval.next().toDate();
				},
			};
		});
}

function isAutoDisabled(schedule: Schedule): boolean {
	const state = loadState()[schedule.name];
	if (!state) return false;
	const max = schedule.maxConsecutiveErrors ?? 5;
	return state.consecutiveErrors >= max;
}

// --- Main loop ---

async function runLoop() {
	let config = loadConfig();
	let trackers = initTrackers(config.schedules ?? []);
	let lastConfigJson = JSON.stringify(config.schedules ?? []);

	function logTrackers() {
		log(`Tracking ${trackers.length} schedule(s):`);
		for (const t of trackers) {
			log(`  ${t.schedule.name}: next fire at ${t.nextFire.toISOString()}`);
		}
	}

	log(`Scheduler started for ${config.name} (executor: ${executor.name})`);
	logTrackers();

	const tick = async () => {
		const now = new Date();

		// Reload config and re-init trackers if schedules changed
		config = loadConfig();
		const currentJson = JSON.stringify(config.schedules ?? []);
		if (currentJson !== lastConfigJson) {
			log("Config changed, reinitializing trackers");
			trackers = initTrackers(config.schedules ?? []);
			lastConfigJson = currentJson;
			logTrackers();
		}

		// Check schedules
		for (const tracker of trackers) {
			const { schedule } = tracker;

			if (isAutoDisabled(schedule)) continue;
			if (activeSessions.has(schedule.name)) continue;

			if (now >= tracker.nextFire) {
				const success = await fireSchedule(schedule, config);

				if (!success) {
					updateState(schedule.name, "error", 0);
				}

				tracker.advance();
				log(
					`  ${schedule.name}: next fire at ${tracker.nextFire.toISOString()}`,
				);
			}
		}

		// Poll active sessions
		for (const [name, active] of Array.from(activeSessions.entries())) {
			const result = await pollSession(active);

			if (result === "done") {
				const durationMs = Date.now() - active.startedAt;
				log(`Session completed: ${name} (${Math.round(durationMs / 1000)}s)`);
				executor.cleanup(active.sessionId);
				updateState(name, "ok", durationMs);
				activeSessions.delete(name);
			} else if (result === "error") {
				const durationMs = Date.now() - active.startedAt;
				// Only count as error if we've been polling for a while (not just a transient fetch failure)
				if (durationMs > 60_000) {
					log(`Session error/lost: ${name}`);
					executor.cleanup(active.sessionId);
					updateState(name, "error", durationMs);
					activeSessions.delete(name);
				}
			}
		}
	};

	// Run every 30 seconds
	const intervalId = setInterval(tick, 30_000);

	// Channel polling — faster interval for responsive chat
	const channels = createChannels();
	const channelIntervalIds: ReturnType<typeof setInterval>[] = [];
	for (const channel of channels) {
		channelIntervalIds.push(setInterval(() => channel.poll(), 5_000));
		await channel.poll(); // initial poll
	}

	// Graceful shutdown
	const shutdown = () => {
		log("Shutting down...");
		clearInterval(intervalId);
		for (const id of channelIntervalIds) clearInterval(id);
		for (const [, active] of activeSessions) {
			executor.cleanup(active.sessionId);
		}
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	// Initial tick
	await tick();
}

async function runNow(scheduleName: string) {
	const config = loadConfig();
	const schedule = config.schedules?.find((s) => s.name === scheduleName);

	if (!schedule) {
		console.error(`Schedule "${scheduleName}" not found in config.yaml`);
		console.error(
			`Available: ${config.schedules?.map((s) => s.name).join(", ") ?? "none"}`,
		);
		process.exit(1);
	}

	log(`Running schedule immediately: ${scheduleName} (executor: ${executor.name})`);
	const success = await fireSchedule(schedule, config);

	if (!success) {
		updateState(scheduleName, "error", 0);
		process.exit(1);
	}

	// Poll until done
	log("Waiting for session to complete...");
	const active = activeSessions.get(scheduleName);
	if (!active) {
		log("No active session to track (may have been queued)");
		return;
	}

	const pollInterval = setInterval(async () => {
		const result = await pollSession(active);
		if (result === "done") {
			const durationMs = Date.now() - active.startedAt;
			log(`Done (${Math.round(durationMs / 1000)}s)`);
			executor.cleanup(active.sessionId);
			updateState(scheduleName, "ok", durationMs);
			clearInterval(pollInterval);
		} else if (result === "error") {
			const durationMs = Date.now() - active.startedAt;
			if (durationMs > 60_000) {
				log("Session lost");
				executor.cleanup(active.sessionId);
				updateState(scheduleName, "error", durationMs);
				clearInterval(pollInterval);
				process.exit(1);
			}
		}
	}, 5_000);
}

// --- Entry point ---

if (typeof args["run-now"] === "string") {
	await runNow(args["run-now"]);
} else {
	await runLoop();
}
