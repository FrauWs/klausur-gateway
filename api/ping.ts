// api/ping.ts

export default function handler(req: any, res: any) {
  return res.status(200).json({
    ok: true,
    route: "/api/ping.ts",
  });
}
