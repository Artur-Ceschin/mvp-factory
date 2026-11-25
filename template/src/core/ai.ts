// LLM access through Amazon Bedrock (Converse API) using the Lambda's IAM role — no API keys.
// AI_DRIVER=stub (tests/dev) returns a deterministic placeholder so tests never call AWS.
// CORE FILE — generated apps must not edit anything under src/core.
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";

export interface CompleteOpts {
  system?: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
}

let client: BedrockRuntimeClient | undefined;

export async function complete(opts: CompleteOpts): Promise<string> {
  if (process.env.AI_DRIVER === "stub" || process.env.DB_DRIVER === "memory") {
    return process.env.AI_STUB_RESPONSE ?? `[stub] ${opts.prompt.slice(0, 80)}`;
  }
  client ??= new BedrockRuntimeClient({ region: process.env.BEDROCK_REGION || process.env.AWS_REGION });
  const r = await client.send(
    new ConverseCommand({
      modelId: process.env.BEDROCK_MODEL_ID,
      system: opts.system ? [{ text: opts.system }] : undefined,
      messages: [{ role: "user", content: [{ text: opts.prompt }] }],
      inferenceConfig: { maxTokens: opts.maxTokens ?? 1500, temperature: opts.temperature ?? 0.4 },
    }),
  );
  return (r.output?.message?.content ?? []).map((c) => ("text" in c ? c.text : "")).join("");
}

/** Asks for JSON and parses the first JSON object/array in the reply. */
export async function completeJson<T = unknown>(opts: CompleteOpts): Promise<T> {
  const text = await complete({
    ...opts,
    system: `${opts.system ?? ""}\nResponda apenas com JSON válido, sem texto extra.`.trim(),
  });
  const match = text.match(/[\[{][\s\S]*[\]}]/);
  if (!match) throw new Error("Model did not return JSON");
  return JSON.parse(match[0]) as T;
}
