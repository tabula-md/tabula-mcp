import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = path.join(rootDir, "tests", "fixtures", "tool-routing-prompts.json");
const serverEntrypoint = path.join(rootDir, "dist", "index.js");
const model = process.env.TABULA_ROUTING_EVAL_MODEL ?? "gpt-5.4-mini";
const repetitions = Number.parseInt(process.env.TABULA_ROUTING_EVAL_REPETITIONS ?? "5", 10);

if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 20) {
  throw new Error("TABULA_ROUTING_EVAL_REPETITIONS must be an integer from 1 to 20");
}

const prompts = JSON.parse(await readFile(fixturePath, "utf8"));
const requestedIds = new Set(
  (process.env.TABULA_ROUTING_EVAL_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const selectedPrompts = requestedIds.size
  ? prompts.filter((fixture) => requestedIds.has(fixture.id))
  : prompts;
if (selectedPrompts.length === 0) {
  throw new Error("TABULA_ROUTING_EVAL_IDS did not match any routing fixture");
}
const tempDir = await mkdtemp(path.join(os.tmpdir(), "tabula-routing-eval-"));

const normalizeSelection = (value) => value.trim().replaceAll("`", "").split(/\s+/)[0] ?? "";
const selectedExpectedTool = (selection, expectedTool) => {
  const normalized = selection.toLowerCase();
  return normalized.includes("tabula") && normalized.endsWith(expectedTool.toLowerCase());
};

const runCodex = (args) => new Promise((resolve, reject) => {
  const child = spawn("codex", args, {
    cwd: rootDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  const timeout = setTimeout(() => {
    child.kill("SIGTERM");
    reject(new Error("Codex routing evaluation timed out after 120 seconds"));
  }, 120_000);
  child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  child.on("error", (error) => {
    clearTimeout(timeout);
    reject(error);
  });
  child.on("close", (code) => {
    clearTimeout(timeout);
    if (code === 0) {
      resolve({ stdout: stdout.join(""), stderr: stderr.join("") });
    } else {
      reject(new Error(`Codex routing evaluation exited ${code}: ${stderr.join("").trim()}`));
    }
  });
});

const parseUsage = (stdout) => {
  let inputTokens = 0;
  let outputTokens = 0;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      const usage = event.usage ?? event.item?.usage ?? event.result?.usage;
      inputTokens += usage?.input_tokens ?? 0;
      outputTokens += usage?.output_tokens ?? 0;
    } catch {
      // Codex JSONL may include non-event status lines; they do not affect routing.
    }
  }
  return { inputTokens, outputTokens };
};

const runPrompt = async (fixture, runNumber) => {
  const outputPath = path.join(tempDir, `${fixture.id}-${runNumber}.txt`);
  const evaluationPrompt = [
    "This is a routing evaluation. Do not execute any product tool or mutate external state.",
    "You may inspect/search tool metadata if needed.",
    "Choose the single best tool for the user's request.",
    "Reply with exactly mcp__tabula.<tool_name> when a Tabula tool is appropriate.",
    "Reply with exactly NO_EXTERNAL_TOOL when Tabula or another external connector is not appropriate.",
    "Reply with exactly OTHER.<qualified_tool_name> when a different external tool is explicitly required.",
    "",
    `User request: ${fixture.prompt}`,
  ].join("\n");

  const { stdout } = await runCodex([
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--model",
    model,
    "--json",
    "--output-last-message",
    outputPath,
    "-c",
    'approval_policy="never"',
    "-c",
    'model_reasoning_effort="low"',
    "-c",
    'mcp_servers.tabula.command="node"',
    "-c",
    `mcp_servers.tabula.args=[${JSON.stringify(serverEntrypoint)},"--read-only"]`,
    "-C",
    tempDir,
    evaluationPrompt,
  ]);

  const selection = normalizeSelection(await readFile(outputPath, "utf8"));
  const passed = fixture.expectedTool
    ? selectedExpectedTool(selection, fixture.expectedTool)
    : selection === "NO_EXTERNAL_TOOL" || selection.startsWith("OTHER.");
  return { selection, passed, ...parseUsage(stdout) };
};

try {
  const results = [];
  for (const fixture of selectedPrompts) {
    for (let runNumber = 1; runNumber <= repetitions; runNumber += 1) {
      const result = await runPrompt(fixture, runNumber);
      results.push({ id: fixture.id, category: fixture.category, expectedTool: fixture.expectedTool, ...result });
      console.log(`${result.passed ? "PASS" : "FAIL"} ${fixture.id} #${runNumber}: ${result.selection}`);
    }
  }

  const categories = Object.fromEntries(
    ["must_tabula", "should_tabula", "must_not_tabula"].map((category) => {
      const categoryResults = results.filter((result) => result.category === category);
      const passed = categoryResults.filter((result) => result.passed).length;
      return [category, { passed, total: categoryResults.length, rate: categoryResults.length ? passed / categoryResults.length : 1 }];
    }),
  );
  const usage = results.reduce(
    (total, result) => ({
      inputTokens: total.inputTokens + result.inputTokens,
      outputTokens: total.outputTokens + result.outputTokens,
    }),
    { inputTokens: 0, outputTokens: 0 },
  );
  const report = { model, repetitions, categories, usage, results };
  await writeFile(path.join(rootDir, "dist", "tool-routing-eval.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ model, repetitions, categories, usage }, null, 2));

  const failed = categories.must_tabula.rate < 1
    || categories.should_tabula.rate < 0.8
    || categories.must_not_tabula.rate < 0.95;
  if (failed) process.exitCode = 1;
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
