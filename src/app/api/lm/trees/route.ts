import { getLaser, parseBbox } from '@/lib/laserCache';

/** Real trees (position, height, crown) detected from Lantmäteriet forest laser data. Cached on disk per area. */
export async function POST(request: Request) {
  const bbox = await parseBbox(request);
  if (bbox instanceof Response) return bbox;
  try {
    const r = await getLaser(bbox);
    return Response.json(r.trees);
  } catch (err) {
    console.error('tree detection failed', err);
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }
}
