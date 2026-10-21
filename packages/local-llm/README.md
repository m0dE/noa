# noa-local-llm

One command that sets up [Noa](https://www.noa.bot)'s **Local model**: Noa working in your Chrome on a model
that runs on your own computer.

```sh
npx -y noa-local-llm
```

It:

1. installs Noa's helper (the same installer as Settings > AI > Local Claude Code),
2. installs [OpenCode](https://opencode.ai), the open-source agent the helper runs the model on: it brings web
   search, reading web pages, skills and thinking, and uses Noa's browser tools,
3. installs [Ollama](https://ollama.com) with its own installer if you have none, and starts it,
4. downloads a model (`qwen3:8b`) and makes `noa-qwen3:8b`, the same model with a 32k context (Noa's
   instructions and tools do not fit in the 4k Ollama gives a model on a computer without a graphics card).

Then, in Noa's Settings > AI, pick **Local model** and click **Find models**: the model it made is picked.
Settings shows the command with your extension's id (`--extension-id`) and the helper version it expects
(`--helper-code`).

Options: `--model <ollama model>` (one that can call tools, e.g. `hermes3:8b`), `--skip-helper`, `--help`.

OpenCode runs without shell or file tools: it reads web pages, and pages are not to be trusted with your
computer. LM Studio, llama.cpp's `llama-server` and vLLM work too: put their address in Settings
(`http://localhost:1234`, `:8080`); a server that wants an API key reads it from `NOA_LOCAL_MODEL_KEY` in
the helper's environment.
