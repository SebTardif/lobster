import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Lobster } from "../src/sdk/Lobster.js";
import { exec, shell } from "../src/sdk/primitives/exec.js";

function emptyInput() {
	return (async function* () {})();
}

function quote(value: string) {
	return JSON.stringify(value);
}

function longChildCommand() {
	const script = [
		'require("node:fs").writeFileSync(process.env.LOBSTER_EXEC_PID_FILE, String(process.pid));',
		"setTimeout(() => {}, 30000);",
	].join("");
	return `${quote(process.execPath)} -e ${quote(script)}`;
}

async function waitForFile(path: string, timeoutMs = 5000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			await access(path);
			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
	throw new Error(`Timed out waiting for ${path}`);
}

function processIsRunning(pid: number) {
	assert.ok(Number.isSafeInteger(pid) && pid > 0, `Invalid child PID: ${pid}`);
	if (process.platform === "darwin") {
		const result = spawnSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
		if (result.stdout?.trim().startsWith("Z")) return false;
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitUntilStopped(pid: number, timeoutMs = 2000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!processIsRunning(pid)) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Child ${pid} was still running after abort`);
}

async function runAbortableStage(stage: ReturnType<typeof exec>, signal: AbortSignal, cwd: string) {
	return stage.run({
		input: emptyInput(),
		ctx: {
			env: { ...process.env, LOBSTER_EXEC_PID_FILE: join(cwd, "pid") },
			cwd,
			signal,
		},
	});
}

test("sdk exec abort signal kills a long-running child", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-sdk-exec-abort-"));
	try {
		const pidFile = join(dir, "pid");
		const controller = new AbortController();
		const pending = runAbortableStage(
			exec(longChildCommand(), { json: false }),
			controller.signal,
			dir,
		);
		await waitForFile(pidFile);
		const pid = Number((await readFile(pidFile, "utf8")).trim());
		assert.equal(processIsRunning(pid), true);
		controller.abort(new Error("abort long exec"));
		await assert.rejects(() => pending, /abort long exec/);
		await waitUntilStopped(pid);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("sdk shell abort signal kills a long-running child", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-sdk-shell-abort-"));
	try {
		const pidFile = join(dir, "pid");
		const controller = new AbortController();
		const pending = runAbortableStage(
			shell(longChildCommand(), { json: false }),
			controller.signal,
			dir,
		);
		await waitForFile(pidFile);
		const pid = Number((await readFile(pidFile, "utf8")).trim());
		assert.equal(processIsRunning(pid), true);
		controller.abort(new Error("abort long shell"));
		await assert.rejects(() => pending, /abort long shell/);
		await waitUntilStopped(pid);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("public Lobster pipe run forwards constructor abort signal", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-public-exec-abort-"));
	try {
		const pidFile = join(dir, "pid");
		const controller = new AbortController();
		const pending = new Lobster({
			env: { ...process.env, LOBSTER_EXEC_PID_FILE: pidFile },
			signal: controller.signal,
		})
			.pipe(exec(longChildCommand(), { json: false }))
			.run();
		await waitForFile(pidFile);
		const pid = Number((await readFile(pidFile, "utf8")).trim());
		assert.equal(processIsRunning(pid), true);
		controller.abort(new Error("abort public lobster"));
		const result = await pending;
		assert.equal(result.ok, false);
		assert.match(result.error?.message ?? "", /abort public lobster/);
		await waitUntilStopped(pid);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
