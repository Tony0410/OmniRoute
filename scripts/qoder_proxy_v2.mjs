import { spawn } from "child_process";
import http from "http";

const PORT = Number.parseInt(process.env.QODER_PROXY_PORT || "20129", 10);
const QODER_BIN = process.env.QODER_BIN || process.env.CLI_QODER_BIN || "qodercli";
const TIMEOUT_MS = Number.parseInt(process.env.QODER_PROXY_TIMEOUT_MS || "120000", 10);

function formatMessages(body) {
  const messages = Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : [];
  const parts = [];
  for (const m of messages) {
    const role = String(m?.role || "user").toUpperCase();
    let content = "";
    if (typeof m?.content === "string") content = m.content;
    else if (Array.isArray(m?.content)) {
      content = m.content
        .map((p) => (typeof p === "string" ? p : p?.text || p?.content || ""))
        .filter(Boolean)
        .join("\n");
    }
    if (content) parts.push(`${role}:\n${content}`);
  }
  return parts.join("\n\n") || String(body.prompt || "");
}

function runQoderCli(token, prompt) {
  return new Promise((resolve) => {
    const args = ["-p", prompt, "--model", "qmodel_latest"];
    const child = spawn(QODER_BIN, args, {
      env: { ...process.env, QODER_PERSONAL_ACCESS_TOKEN: token },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, TIMEOUT_MS);
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (killed) return resolve({ ok: false, status: 504, error: "qodercli timeout", stderr, stdout });
      if (code !== 0) return resolve({ ok: false, status: 502, error: `qodercli exit ${code}`, stderr, stdout });
      resolve({ ok: true, stdout: stdout.trim(), stderr });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, status: 502, error: e.message, stderr, stdout });
    });
  });
}

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    return json(res, 200, { ok: true, qoderBin: QODER_BIN });
  }
  if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
    return json(res, 404, { error: { message: "not found" } });
  }

  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", async () => {
    try {
      const auth = String(req.headers.authorization || "");
      const token = auth.replace(/^Bearer\s+/i, "").trim() || process.env.QODER_PERSONAL_ACCESS_TOKEN || "";
      if (!token) return json(res, 401, { error: { message: "Missing Qoder PAT" } });

      const body = raw ? JSON.parse(raw) : {};
      const model = body.model || "qoder-rome-30ba3b";
      const prompt = formatMessages(body);
      const result = await runQoderCli(token, prompt);
      if (!result.ok) {
        return json(res, result.status || 502, {
          error: {
            message: result.error,
            stderr: String(result.stderr || "").slice(-2000),
            stdout: String(result.stdout || "").slice(-2000),
          },
        });
      }

      const created = Math.floor(Date.now() / 1000);
      const id = "chatcmpl-qoder-" + Math.random().toString(36).slice(2);
      if (body.stream) {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/event-stream");
        const payload = { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content: result.stdout }, finish_reason: null }] };
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
        res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
        res.write("data: [DONE]\n\n");
        return res.end();
      }

      return json(res, 200, {
        id,
        object: "chat.completion",
        created,
        model,
        choices: [{ index: 0, message: { role: "assistant", content: result.stdout }, finish_reason: "stop" }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    } catch (e) {
      return json(res, 400, { error: { message: e?.message || String(e) } });
    }
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Qoder CLI proxy listening on http://127.0.0.1:${PORT} using ${QODER_BIN}`);
});
