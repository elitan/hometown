import { getLaser, parseBbox } from '@/lib/laserCache';

/**
 * Height above ground from the laser data (roofs, trees), 1 m grid, raw little-endian Uint16 centimetres,
 * row 0 = north; grid info in the X-Grid header. Shares one cached processing run with /api/lm/trees.
 */
export async function POST(request: Request) {
  const bbox = await parseBbox(request);
  if (bbox instanceof Response) return bbox;
  try {
    const r = await getLaser(bbox);
    return new Response(new Uint8Array(r.surface), { headers: { 'Content-Type': 'application/octet-stream', 'X-Grid': JSON.stringify(r.info) } });
  } catch (err) {
    console.error('surface failed', err);
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }
}
