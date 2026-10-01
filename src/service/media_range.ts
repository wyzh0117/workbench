/** Stream one file without materialising the response in renderer-sized memory. */
export async function fileRangeResponse(
  path: string,
  mime: string,
  request: Request,
): Promise<Response> {
  const file = await Deno.open(path, { read: true });
  let open = true;
  const close = () => {
    if (!open) return;
    open = false;
    file.close();
  };
  try {
    const metadata = await file.stat();
    if (!metadata.isFile || !Number.isSafeInteger(metadata.size)) {
      throw new Error("视频来源不是可读取的普通文件");
    }
    const size = metadata.size;
    let start = 0;
    let end = Math.max(0, size - 1);
    let status = 200;
    const rawRange = request.headers.get("range");
    if (rawRange !== null) {
      const parsed = parseByteRange(rawRange, size);
      if (!parsed) {
        close();
        return new Response(null, {
          status: 416,
          headers: {
            "accept-ranges": "bytes",
            "content-range": `bytes */${size}`,
            "cache-control": "no-store",
          },
        });
      }
      ({ start, end } = parsed);
      status = 206;
    }
    const length = size === 0 ? 0 : end - start + 1;
    const headers = new Headers({
      "accept-ranges": "bytes",
      "cache-control": "no-store",
      "content-length": String(length),
      "content-type": mime,
    });
    if (status === 206) headers.set("content-range", `bytes ${start}-${end}/${size}`);
    if (request.method === "HEAD" || length === 0) {
      close();
      return new Response(null, { status, headers });
    }

    await file.seek(start, Deno.SeekMode.Start);
    let remaining = length;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!open || remaining <= 0) {
          close();
          controller.close();
          return;
        }
        const chunk = new Uint8Array(Math.min(64 * 1024, remaining));
        try {
          const count = await file.read(chunk);
          if (count === null || count === 0) {
            close();
            controller.error(new Error("视频来源读取中断"));
            return;
          }
          remaining -= count;
          controller.enqueue(chunk.subarray(0, count));
          if (remaining === 0) close();
        } catch (error) {
          close();
          controller.error(error);
        }
      },
      cancel() {
        close();
      },
    });
    return new Response(body, { status, headers });
  } catch (error) {
    close();
    throw error;
  }
}

function parseByteRange(
  value: string,
  size: number,
): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim());
  if (!match || value.includes(",") || size <= 0 || (!match[1] && !match[2])) return null;
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) return null;
    end = Math.min(end, size - 1);
  }
  return { start, end };
}
