// A minimal PNG decoder for data tiles (8-bit RGB/RGBA, not interlaced), so their exact bytes are read
// without a canvas. Browsers with fingerprinting protection (Safari, Brave, Firefox resistFingerprinting)
// add noise to canvas reads, which turns height-encoded pixels into spikes hundreds of metres tall.

export type RawImage = { width: number; height: number; channels: number; data: Uint8Array };

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function decodePng(buf: ArrayBuffer): Promise<RawImage> {
  const b = new Uint8Array(buf), dv = new DataView(buf);
  if (b[0] !== 0x89 || b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47) throw new Error('Not a PNG');
  let width = 0, height = 0, channels = 0;
  const idat: Uint8Array[] = [];
  for (let o = 8; o + 8 <= b.length;) {
    const len = dv.getUint32(o), type = String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]), body = b.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') {
      width = dv.getUint32(o + 8); height = dv.getUint32(o + 12);
      const depth = body[8], color = body[9], interlace = body[12];
      if (depth !== 8 || (color !== 2 && color !== 6) || interlace !== 0) throw new Error(`Unsupported PNG (depth ${depth}, color ${color}, interlace ${interlace})`);
      channels = color === 6 ? 4 : 3;
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    o += 12 + len;
  }
  const joined = new Uint8Array(idat.reduce((n, c) => n + c.length, 0));
  idat.reduce((o, c) => (joined.set(c, o), o + c.length), 0);
  const raw = await inflate(joined);

  // undo the per-row filters
  const stride = width * channels, data = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = data.subarray(y * stride, (y + 1) * stride), up = y > 0 ? data.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? row[i - channels] : 0, c = up && i >= channels ? up[i - channels] : 0, u = up ? up[i] : 0;
      let p = 0;
      if (f === 1) p = a;
      else if (f === 2) p = u;
      else if (f === 3) p = (a + u) >> 1;
      else if (f === 4) { const q = a + u - c, pa = Math.abs(q - a), pb = Math.abs(q - u), pc = Math.abs(q - c); p = pa <= pb && pa <= pc ? a : pb <= pc ? u : c; }
      row[i] = (src[i] + p) & 255;
    }
  }
  return { width, height, channels, data };
}
