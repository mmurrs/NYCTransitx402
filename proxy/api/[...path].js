// Vercel serverless proxy → backend API.
//
// CRITICAL: disable Vercel's automatic body parsing. Otherwise Vercel
// pre-parses JSON bodies into `req.body` AND consumes the raw stream,
// leaving us with no way to forward the original bytes downstream. The
// backend would receive the forwarded Content-Length header but 0 body
// bytes, causing `express.json()` to parse `{}` and every POST to fail
// its schema validator with "lat and lng are required numeric fields".
export const config = {
  api: {
    bodyParser: false,
  },
};

const BACKEND = process.env.BACKEND_URL || "http://localhost:8080";

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return chunks.length === 0 ? undefined : Buffer.concat(chunks);
}

export default async function handler(req, res) {
  const path = req.url;
  const url = `${BACKEND}${path}`;

  const forwardedHeaders = Object.fromEntries(
    Object.entries(req.headers).filter(
      ([k]) => !["host", "connection", "content-length"].includes(k.toLowerCase())
    )
  );

  let body;
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    try {
      body = await readRawBody(req);
    } catch (err) {
      return res.status(400).json({ error: "Failed to read request body" });
    }
  }

  try {
    const response = await fetch(url, {
      method: req.method,
      headers: forwardedHeaders,
      body,
      duplex: body ? "half" : undefined,
    });

    res.status(response.status);
    for (const [key, value] of response.headers.entries()) {
      if (!["transfer-encoding", "content-encoding", "content-length"].includes(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    }

    const respBuf = Buffer.from(await response.arrayBuffer());
    res.send(respBuf);
  } catch (err) {
    res.status(502).json({ error: "Backend unreachable" });
  }
}
