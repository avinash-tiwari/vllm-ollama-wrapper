import express from "express";
import crypto from "node:crypto";

const app = express();
app.use(express.json({ limit: "10mb" }));

const PORT = Number(process.env.PORT || 8000);
const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL || "http://localhost:11434").replace(/\/$/, "");
const DEFAULT_MODEL = process.env.OLLAMA_MODEL || "gemma4";
const API_KEY = process.env.API_KEY || "";

function requestId() {
  return `chatcmpl-${crypto.randomUUID()}`;
}

function created() {
  return Math.floor(Date.now() / 1000);
}

function auth(req, res, next) {
  if (!API_KEY) return next();

  const header = req.headers.authorization || "";
  if (header !== `Bearer ${API_KEY}`) {
    return res.status(401).json({
      error: {
        message: "Invalid API key",
        type: "invalid_request_error",
        code: "invalid_api_key"
      }
    });
  }
  next();
}

function contentToText(content) {
  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    return content
      .filter(part => part?.type === "text")
      .map(part => part.text || "")
      .join("");
  }

  return "";
}

/**
 * vLLM/OpenAI -> Ollama request mapping.
 *
 * Important:
 * - max_tokens -> options.num_predict
 * - temperature/top_p/top_k/seed/stop -> options.*
 * - messages/tools are passed through because Ollama's chat API accepts
 *   OpenAI-shaped chat messages/tools.
 */
function toOllamaChatRequest(body) {
  const extraBody = body.extra_body || {};

  const options = {
    ...(body.temperature !== undefined && {
      temperature: body.temperature
    }),
    ...(body.top_p !== undefined && {
      top_p: body.top_p
    }),
    ...(body.max_tokens !== undefined && {
      num_predict: body.max_tokens
    }),
    ...(body.stop !== undefined && {
      stop: body.stop
    })
  };

  const request = {
    model: body.model || DEFAULT_MODEL,
    messages: body.messages || [],
    stream: Boolean(body.stream),
    options
  };

  // vLLM guided_json -> Ollama structured output
  if (extraBody.guided_json) {
    request.format = extraBody.guided_json;
  }

  return request;
}

function usageFromOllama(data) {
  return {
    prompt_tokens: data.prompt_eval_count || 0,
    completion_tokens: data.eval_count || 0,
    total_tokens: (data.prompt_eval_count || 0) + (data.eval_count || 0)
  };
}

function toVllmResponse(ollama, model, id, createdAt) {
  const message = ollama.message || {};
  const choice = {
    index: 0,
    message: {
      role: message.role || "assistant",
      content: message.content ?? null
    },
    finish_reason: ollama.done_reason === "length" ? "length" : "stop"
  };

  if (message.tool_calls?.length) {
    choice.message.tool_calls = message.tool_calls.map((call, index) => ({
      id: call.id || `call_${index}`,
      type: "function",
      function: {
        name: call.function?.name,
        arguments: typeof call.function?.arguments === "string"
          ? call.function.arguments
          : JSON.stringify(call.function?.arguments || {})
      }
    }));
    choice.finish_reason = "tool_calls";
  }

  return {
    id,
    object: "chat.completion",
    created: createdAt,
    model,
    choices: [choice],
    usage: usageFromOllama(ollama)
  };
}

async function callOllama(payload) {
  const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...payload, stream: false })
  });

  if (!response.ok) {
    const text = await response.text();
    const error = new Error(text || `Ollama returned HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }

  return response.json();
}

function sendSse(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/v1/models", auth, (req, res) => {
  const model = req.query.model || DEFAULT_MODEL;

  res.json({
    object: "list",
    data: [{
      id: model,
      object: "model",
      created: created(),
      owned_by: "ollama"
    }]
  });
});

app.post("/v1/chat/completions", auth, async (req, res) => {
  const body = req.body || {};

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return res.status(400).json({
      error: {
        message: "messages must be a non-empty array",
        type: "invalid_request_error",
        param: "messages",
        code: null
      }
    });
  }

  const payload = toOllamaChatRequest(body);
  const model = payload.model;
  const id = requestId();
  const createdAt = created();

  try {
    // Non-streaming: return a vLLM/OpenAI-style response.
    if (!body.stream) {
      const ollama = await callOllama(payload);
      return res.json(toVllmResponse(ollama, model, id, createdAt));
    }

    // Streaming: translate Ollama NDJSON into OpenAI/vLLM SSE chunks.
    payload.stream = true;

    const upstream = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!upstream.ok) {
      const text = await upstream.text();
      return res.status(upstream.status).json({
        error: {
          message: text || `Ollama returned HTTP ${upstream.status}`,
          type: "upstream_error"
        }
      });
    }

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let firstChunk = true;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;

        let chunk;
        try {
          chunk = JSON.parse(line);
        } catch {
          continue;
        }

        const message = chunk.message || {};
        const delta = {
          role: firstChunk ? "assistant" : undefined,
          content: message.content || ""
        };

        if (!delta.role) delete delta.role;

        if (message.tool_calls?.length) {
          delta.tool_calls = message.tool_calls.map((call, index) => ({
            index,
            id: call.id || `call_${index}`,
            type: "function",
            function: {
              name: call.function?.name,
              arguments: typeof call.function?.arguments === "string"
                ? call.function.arguments
                : JSON.stringify(call.function?.arguments || {})
            }
          }));
        }

        const finishReason = chunk.done
          ? (message.tool_calls?.length ? "tool_calls" : "stop")
          : null;

        sendSse(res, {
          id,
          object: "chat.completion.chunk",
          created: createdAt,
          model,
          choices: [{
            index: 0,
            delta,
            finish_reason: finishReason
          }]
        });

        firstChunk = false;
      }
    }

    sendSse(res, "[DONE]");
    res.end();
  } catch (error) {
    console.error(error);

    if (!res.headersSent) {
      return res.status(error.status || 502).json({
        error: {
          message: error.message || "Ollama request failed",
          type: "upstream_error"
        }
      });
    }

    res.end();
  }
});

/**
 * Minimal /v1/completions compatibility.
 * Converts a prompt into a single user message and reuses /api/chat.
 */
app.post("/v1/completions", auth, async (req, res) => {
  const body = req.body || {};

  if (typeof body.prompt !== "string") {
    return res.status(400).json({
      error: {
        message: "prompt must be a string",
        type: "invalid_request_error",
        param: "prompt",
        code: null
      }
    });
  }

  const chatBody = {
    ...body,
    messages: [{ role: "user", content: body.prompt }]
  };

  delete chatBody.prompt;

  try {
    const ollama = await callOllama(toOllamaChatRequest(chatBody));
    const text = ollama.message?.content || "";

    res.json({
      id: requestId(),
      object: "text_completion",
      created: created(),
      model: chatBody.model || DEFAULT_MODEL,
      choices: [{
        text,
        index: 0,
        logprobs: null,
        finish_reason: ollama.done_reason === "length" ? "length" : "stop"
      }],
      usage: usageFromOllama(ollama)
    });
  } catch (error) {
    res.status(error.status || 502).json({
      error: {
        message: error.message || "Ollama request failed",
        type: "upstream_error"
      }
    });
  }
});

app.listen(PORT, () => {
  console.log(`vLLM -> Ollama wrapper listening on http://localhost:${PORT}`);
  console.log(`Ollama: ${OLLAMA_BASE_URL}`);
  console.log(`Model:  ${DEFAULT_MODEL}`);
});
