// api/analyze.ts

export default async function handler(req: Request) {
  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({
        ok: false,
        error: "METHOD_NOT_ALLOWED",
        message: "Use POST with JSON body.",
      }),
      {
        status: 405,
        headers: {
          "Content-Type": "application/json",
          "Allow": "POST",
        },
      }
    );
  }

  let body: unknown;

  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({
        ok: false,
        error: "INVALID_JSON",
      }),
      {
        status: 400,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
  }

  return new Response(
    JSON.stringify({
      ok: true,
      route: "/api/analyze.ts",
      received: body,
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    }
  );
}
