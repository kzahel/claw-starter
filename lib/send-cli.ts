#!/usr/bin/env tsx

/**
 * Unified message send CLI — dispatches to the appropriate transport.
 *
 * Usage:
 *   send --transport telegram --to <chat-id> --message "text"
 *   send --transport telegram --message "text"          # uses default from .env
 *   send --transport gmail --to <addr> --subject <subj> --message "text"
 *   send --transport log --message "text"               # append to file (default)
 *
 * Requires transport-specific credentials in the instance .env file.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadEnv, resolveInstanceDir } from "./utils.js";

// --- Resolve instance dir ---

const instanceDir = resolveInstanceDir();

const env = loadEnv(instanceDir);

// --- CLI args ---

const { values } = parseArgs({
	options: {
		transport: { type: "string", default: "log" },
		to: { type: "string" },
		message: { type: "string" },
		"message-file": { type: "string" },
		subject: { type: "string" },
	},
	strict: false,
});

let text = values.message ?? "";
if (values["message-file"]) {
	text = readFileSync(resolve(values["message-file"] as string), "utf-8");
}

if (!text) {
	console.error("No message. Use --message or --message-file.");
	process.exit(1);
}

// --- Transports ---

async function sendTelegram(to: string, message: string) {
	const token = env.TELEGRAM_BOT_TOKEN ?? process.env.TELEGRAM_BOT_TOKEN;
	if (!token) {
		console.error("TELEGRAM_BOT_TOKEN not set.");
		process.exit(1);
	}

	const chatId = to || env.TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
	if (!chatId) {
		console.error("No recipient. Use --to or set TELEGRAM_CHAT_ID.");
		process.exit(1);
	}

	const MAX_LEN = 4096;
	for (let i = 0; i < message.length; i += MAX_LEN) {
		const res = await fetch(
			`https://api.telegram.org/bot${token}/sendMessage`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					chat_id: chatId,
					text: message.slice(i, i + MAX_LEN),
				}),
			},
		);
		const data = (await res.json()) as { ok: boolean; description?: string };
		if (!data.ok) {
			console.error(`Telegram error: ${data.description}`);
			process.exit(1);
		}
	}

	// Log to chat history
	const stateDir = join(instanceDir, "state");
	if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
	appendFileSync(
		join(stateDir, "telegram-history.jsonl"),
		`${JSON.stringify({
			ts: new Date().toISOString(),
			role: "assistant",
			name: "Scout",
			chatId,
			text: message,
		})}\n`,
	);

	console.log(`Sent via Telegram to ${chatId}.`);
}

async function sendGmail(to: string, message: string) {
	// Delegate to gmail-cli
	const { execSync } = await import("node:child_process");
	const gmailCli = resolve(import.meta.dirname ?? ".", "gmail-cli.ts");
	const subject = values.subject ?? "[Scout] Message";
	execSync(
		`ASSISTANT_INSTANCE_DIR=${instanceDir} tsx ${gmailCli} send --to ${JSON.stringify(to)} --subject ${JSON.stringify(subject)} --body ${JSON.stringify(message)}`,
		{ stdio: "inherit" },
	);
}

function sendLog(message: string) {
	const logDir = join(instanceDir, "memory");
	if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
	appendFileSync(
		join(logDir, "send-log.jsonl"),
		`${JSON.stringify({ ts: new Date().toISOString(), message })}\n`,
	);
	console.log("Logged to memory/send-log.jsonl");
}

// --- Audit log ---

function auditLog(transport: string, to: string, status: "ok" | "error", error?: string) {
	const logDir = join(instanceDir, "state");
	if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
	appendFileSync(
		join(logDir, "send-audit.jsonl"),
		`${JSON.stringify({
			ts: new Date().toISOString(),
			transport,
			to: to || undefined,
			subject: values.subject || undefined,
			status,
			error: error || undefined,
			len: text.length,
		})}\n`,
	);
}

// --- Dispatch ---

const transport = values.transport as string;
const to = values.to ?? "";

try {
	switch (transport) {
		case "telegram":
			await sendTelegram(to, text);
			break;
		case "gmail":
			if (!to) {
				console.error("--to required for gmail transport.");
				process.exit(1);
			}
			await sendGmail(to, text);
			break;
		case "log":
			sendLog(text);
			break;
		default:
			console.error(`Unknown transport: ${transport}`);
			console.error("Available: telegram, gmail, log");
			process.exit(1);
	}
	auditLog(transport, to, "ok");
} catch (err: unknown) {
	const msg = err instanceof Error ? err.message : String(err);
	auditLog(transport, to, "error", msg);
	throw err;
}
