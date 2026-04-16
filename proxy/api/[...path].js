const BACKEND = process.env.BACKEND_URL;

if (!BACKEND) {
  throw new Error("BACKEND_URL environment variable is required");
}

export default async function handler(req, res) {
  const path = req.url;
  const url = `${BACKEND}${path}`;

  try {
    const response = await fetch(url, {
      method: req.method,
      headers: {
        ...Object.fromEntries(
          Object.entries(req.headers).filter(
            ([k]) => !["host", "connection"].includes(k.toLowerCase())
          )
        ),
      },
    });

    // Forward status and headers
    res.status(response.status);
    for (const [key, value] of response.headers.entries()) {
      if (!["transfer-encoding", "content-encoding"].includes(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    }

    const body = await response.text();
    res.send(body);
  } catch (err) {
    res.status(502).json({ error: "Backend unreachable" });
  }
}
