// sample.js — re-tool demo file (M0)
const config = {
  apiKey: "secret-token-123",
  endpoint: "https://api.example.com/v1",
};

function fetchData(token) {
  console.log("using token:", token);
  return { ok: true, data: [1, 2, 3] };
}

const token = config.apiKey;
const result = fetchData(token);

// the term "token" appears again below
const TOKEN_PATTERN = /^token:/;
const raw = "token:abc123";
const hex = "\x68\x65\x78\x20\x65\x6e\x63\x6f\x64\x65\x64";
