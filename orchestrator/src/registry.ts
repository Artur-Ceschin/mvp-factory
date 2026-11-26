import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { paths } from "./config.js";

export type AppStatus = "building" | "built" | "build-failed" | "deploy-failed" | "live" | "killed";
export type Decision = "warming-up" | "needs-traffic" | "iterate" | "scale" | "kill-candidate";

export interface Scorecard {
  at: string;
  windowDays: number;
  visitors: number;
  signups: number;
  activated: number;
  paid: number;
  canceled: number;
  dauAvg: number;
  signupRate: number;
  activationRate: number;
  paidRate: number;
  decision: Decision;
  reason: string;
}

export interface AppRecord {
  slug: string;
  status: AppStatus;
  createdAt: string;
  liveSince?: string;
  urls: Record<string, string>;
  version?: string;
  builds: {
    at: string;
    kind: "build" | "iterate";
    ok: boolean;
    costUsd: number;
    attempts: number;
    note?: string;
    /** Final design-review score (1–10), when the review ran. */
    designScore?: number;
    /** Every design-review score of this build, in order (initial review, then after each polish). */
    designScores?: number[];
  }[];
  lastScore?: Scorecard;
  scoreHistory?: Scorecard[];
}

export type Registry = Record<string, AppRecord>;

export function readRegistry(file = paths.registry): Registry {
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Registry) : {};
}

export function writeRegistry(reg: Registry, file = paths.registry) {
  writeFileSync(file, JSON.stringify(reg, null, 2) + "\n");
}

export function updateApp(slug: string, fn: (r: AppRecord) => void, file = paths.registry) {
  const reg = readRegistry(file);
  const rec: AppRecord = reg[slug] ?? { slug, status: "building", createdAt: new Date().toISOString(), urls: {}, builds: [] };
  fn(rec);
  reg[slug] = rec;
  writeRegistry(reg, file);
  return rec;
}
