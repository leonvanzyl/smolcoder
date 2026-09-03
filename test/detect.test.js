const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const {
  detectOllamaModels,
  ollamaBaseUrls,
  parseDockerOllamaBaseUrls,
} = require("../dist/detect");

test("Ollama candidates cover Windows and IPv6 loopback spellings", () => {
  assert.deepEqual(ollamaBaseUrls(undefined).slice(0, 3), [
    "http://127.0.0.1:11434",
    "http://localhost:11434",
    "http://[::1]:11434",
  ]);
  assert.deepEqual(ollamaBaseUrls("localhost").slice(0, 3), [
    "http://localhost:11434",
    "http://127.0.0.1:11434",
    "http://[::1]:11434",
  ]);
  assert.equal(ollamaBaseUrls("0.0.0.0")[0], "http://127.0.0.1:11434");
});

test("a remote OLLAMA_HOST is tried before local fallbacks", () => {
  assert.deepEqual(ollamaBaseUrls("http://model-box:22114").slice(0, 2), [
    "http://model-box:22114",
    "http://127.0.0.1:11434",
  ]);
});

test("Docker port discovery finds nonstandard published Ollama ports", () => {
  const output = [
    "0.0.0.0:49160->11434/tcp, [::]:49160->11434/tcp",
    "127.0.0.1:22114->11434/tcp",
    "0.0.0.0:3000->3000/tcp",
    "11434/tcp",
  ].join("\n");
  assert.deepEqual(parseDockerOllamaBaseUrls(output), [
    "http://127.0.0.1:49160",
    "http://[::1]:49160",
    "http://127.0.0.1:22114",
  ]);
});

test("Ollama detection falls back between loopback addresses", async () => {
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ models: [{ name: "local-test:latest" }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const old = process.env.OLLAMA_HOST;
  process.env.OLLAMA_HOST = `[::1]:${port}`;
  try {
    const models = await detectOllamaModels();
    assert.equal(models.length, 1);
    assert.equal(models[0].id, "local-test:latest");
    assert.equal(models[0].baseUrl, `http://127.0.0.1:${port}`);
  } finally {
    if (old === undefined) delete process.env.OLLAMA_HOST;
    else process.env.OLLAMA_HOST = old;
    await new Promise((resolve) => server.close(resolve));
  }
});
