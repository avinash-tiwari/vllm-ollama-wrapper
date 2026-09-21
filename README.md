# vLLM -> Ollama Wrapper

A small Node.js HTTP wrapper that exposes an OpenAI/vLLM-compatible API while using Ollama as the inference backend.

The main purpose is to let an existing application that talks to:

```text
POST /v1/chat/completions
```

continue using the same request/response contract while the actual model is served by Ollama.

## Architecture

```text
Existing Node application
          |
          | OpenAI / vLLM contract
          v
+-----------------------------+
| vLLM -> Ollama Wrapper      |
| Node.js + Express           |
+-----------------------------+
          |
          | Ollama /api/chat
          v
+-----------------------------+
| Ollama                      |
| gemma4                      |
+-----------------------------+
```

## Requirements

- Node.js 18+
- Ollama running locally
- A model available in Ollama, e.g. `gemma4`

Check Ollama:

```bash
ollama list
```

If required:

```bash
ollama pull gemma4
```

## Run

```bash
npm install
cp .env.example .env
npm start
```

The wrapper listens on:

```text
http://localhost:8000
```

## Existing vLLM client can point here

If the current application has something like:

```text
http://vllm-host:8000/v1
```

change only the base URL to:

```text
http://localhost:8000/v1
```

The application can continue sending:

```json
{
  "model": "gemma4",
  "messages": [
    {
      "role": "system",
      "content": "You are a helpful assistant."
    },
    {
      "role": "user",
      "content": "Explain Redis in one sentence."
    }
  ],
  "temperature": 0.2,
  "top_p": 0.9,
  "max_tokens": 200
}
```

## Test

### Non-streaming

```bash
curl http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemma4",
    "messages": [
      {"role": "user", "content": "What is Node.js?"}
    ],
    "temperature": 0,
    "max_tokens": 100,
    "stream": false
  }'
```

Response shape:

```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "created": 1750000000,
  "model": "gemma4",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "..."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 12,
    "completion_tokens": 20,
    "total_tokens": 32
  }
}
```

### Streaming

```bash
curl http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -N \
  -d '{
    "model": "gemma4",
    "messages": [
      {"role": "user", "content": "Write a short story about a robot."}
    ],
    "stream": true
  }'
```

The wrapper converts Ollama's newline-delimited JSON stream into OpenAI/vLLM-style SSE:

```text
data: {"id":"chatcmpl-...","object":"chat.completion.chunk",...}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk",...}

data: [DONE]
```

## Parameter mapping

| vLLM/OpenAI request | Ollama request |
|---|---|
| `model` | `model` |
| `messages` | `messages` |
| `temperature` | `options.temperature` |
| `top_p` | `options.top_p` |
| `top_k` | `options.top_k` |
| `seed` | `options.seed` |
| `max_tokens` | `options.num_predict` |
| `max_completion_tokens` | `options.num_predict` |
| `stop` | `options.stop` |
| `response_format.type=json` | `format=json` |
| `response_format.type=json_schema` | `format=<schema>` |
| `tools` | `tools` |
| `keep_alive` | `keep_alive` |
| `think` | `think` |

Unsupported vLLM-specific fields are intentionally ignored rather than blindly forwarding them to Ollama.

## Endpoints

Implemented:

```text
GET  /health
GET  /v1/models
POST /v1/chat/completions
POST /v1/completions
```

The important one for most applications is:

```text
POST /v1/chat/completions
```

## API key

Set:

```env
API_KEY=my-secret
```

Then clients must send:

```http
Authorization: Bearer my-secret
```

The key is checked by the wrapper. Ollama itself does not need to know about this key.

## Important limitation

This is a compatibility layer, not a full reimplementation of vLLM.

The OpenAI/vLLM API is broad and vLLM supports additional generation parameters and APIs. The wrapper should therefore be extended only for the exact contract your application uses.

For example, if your current application uses:

- `/v1/chat/completions`
- `stream`
- `tools`
- JSON/structured output
- specific sampling parameters

those should be tested against Gemma 4 and Ollama and then locked down with integration tests.

## Recommended production structure

For a real service, I would eventually split this into:

```text
src/
  server.js
  routes/
    chat.js
    completions.js
    models.js
  adapters/
    ollama.js
    vllm.js
  transformers/
    request.js
    response.js
    stream.js
  middleware/
    auth.js
  tests/
    chat.test.js
```

That makes the inference backend replaceable instead of coupling the HTTP contract directly to Ollama.
