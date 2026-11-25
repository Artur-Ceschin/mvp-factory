import { spawn } from "node:child_process";

export interface ExecResult {
  code: number;
  output: string;
  ms: number;
}

/** Runs a command without a shell, capturing combined output (tail-trimmed). */
export function run(
  cmd: string,
  args: string[],
  opts: { cwd: string; env?: Record<string, string | undefined>; timeoutMs?: number; echo?: boolean } ,
): Promise<ExecResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env, FORCE_COLOR: "0", CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const onData = (d: Buffer) => {
      const s = d.toString();
      output += s;
      if (output.length > 200_000) output = output.slice(-100_000);
      if (opts.echo) process.stdout.write(s);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const timer = setTimeout(() => {
      output += `\n[timeout after ${opts.timeoutMs}ms]`;
      child.kill("SIGKILL");
    }, opts.timeoutMs ?? 10 * 60_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output, ms: Date.now() - started });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: 127, output: String(e), ms: Date.now() - started });
    });
  });
}

export const tail = (s: string, n = 6000) => (s.length > n ? `…${s.slice(-n)}` : s);

export const log = (msg: string) => console.log(`[factory ${new Date().toISOString().slice(11, 19)}] ${msg}`);
