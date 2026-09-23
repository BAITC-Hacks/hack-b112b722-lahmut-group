import { test as base, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { resolve, join } from "node:path";

const root = resolve(import.meta.dirname, "../..");
export const python = process.env.E2E_PYTHON || join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");

export class TestServer {
  process?: ChildProcess;
  url = "";
  port = 0;
  directory = "";
  log: ReturnType<typeof createWriteStream> | undefined;

  async start(scenario = "unavailable") {
    if (!this.port) {
      this.port = await new Promise<number>((accept, reject) => {
        const listener = createServer();
        listener.once("error", reject);
        listener.listen(0, "127.0.0.1", () => {
          const port = (listener.address() as { port: number }).port;
          listener.close(() => accept(port));
        });
      });
      mkdirSync(join(root, "artifacts"), { recursive: true });
      this.directory = mkdtempSync(join(root, "artifacts", "ml-e2e-"));
      this.url = `http://127.0.0.1:${this.port}`;
      this.log = createWriteStream(join(this.directory, "server.log"), { flags: "a" });
    }
    if (!existsSync(python)) throw new Error(`Python not found: ${python}. Set E2E_PYTHON.`);
    this.process = spawn(python, ["-m", "backend.testing.server", "--port", String(this.port), "--data-dir", this.directory, "--scenario", scenario], {
      cwd: root, env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" }, windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.process.stdout?.pipe(this.log!, { end: false });
    this.process.stderr?.pipe(this.log!, { end: false });
    let failure: Error | undefined;
    this.process.on("error", (error) => { failure = error; });
    for (let i = 0; i < 100; i++) {
      if (failure) throw failure;
      if (this.process.exitCode !== null) throw new Error(`Test server exited; inspect ${this.directory}/server.log`);
      try {
        const response = await fetch(this.url + "/api/health");
        if (response.ok && (await response.json()).details.test_mode === true) return;
      } catch { /* Wait for this process to start listening. */ }
      await new Promise((done) => setTimeout(done, 100));
    }
    throw new Error(`Test server did not become ready; inspect ${this.directory}/server.log`);
  }

  async stop() {
    const child = this.process;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((done) => child.once("exit", () => done()));
    child.kill("SIGKILL"); // Intentional crash of our disposable server, including Windows.
    await exited;
    this.process = undefined;
  }
}

export const test = base.extend<{ resetStub: void }, { server: TestServer | undefined }>({
  server: [async ({}, use) => {
    if (!process.env.MANAGED_ML_STUB) { await use(undefined); return; }
    const server = new TestServer();
    try { await server.start(); await use(server); }
    finally { await server.stop(); server.log?.end(); }
  }, { scope: "worker", auto: true }],
  baseURL: async ({ server }, use) => {
    await use(server?.url || process.env.UI_BASE_URL || "http://127.0.0.1:5173");
  },
  resetStub: [async ({ server, request }, use) => {
    if (server) {
      await request.post("/__test__/release");
      await expect.poll(async () => (await (await request.get("/__test__/state")).json()).active).toBe(0);
      expect((await request.post("/__test__/scenario", { data: { name: "unavailable", delay_ms: 30 } })).ok()).toBeTruthy();
    }
    try { await use(); }
    finally { if (server?.process) await request.post("/__test__/release"); }
  }, { auto: true }],
});
export { expect };
