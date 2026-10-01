import { fileRangeResponse } from "../src/service/media_range.ts";
import { resolveFolderVideoSource } from "../src/service/folder_scan.ts";

Deno.test("video Range responses stream files larger than the preview byte limit", async () => {
  const directory = await Deno.makeTempDir({ prefix: "workbench-media-range-" });
  const path = `${directory}/large.mp4`;
  const size = 17 * 1024 * 1024 + 19;
  const file = await Deno.open(path, { create: true, read: true, write: true });
  try {
    await file.truncate(size);
    const head = new TextEncoder().encode("ftyp-mp4");
    await file.write(head);
    await file.seek(size - 4, Deno.SeekMode.Start);
    await file.write(new TextEncoder().encode("tail"));
  } finally {
    file.close();
  }

  try {
    const source = await resolveFolderVideoSource(directory, "large.mp4");
    if (source.size !== size || source.mime !== "video/mp4") throw new Error("large video source must resolve without reading its contents");
    let rejectedTraversal = false;
    try {
      await resolveFolderVideoSource(directory, "../large.mp4");
    } catch {
      rejectedTraversal = true;
    }
    if (!rejectedTraversal) throw new Error("folder video source must reject path traversal");

    const response = await fileRangeResponse(
      path,
      "video/mp4",
      new Request("http://localhost/api/media/test", { headers: { range: "bytes=0-" } }),
    );
    if (response.status !== 206) throw new Error(`expected 206, got ${response.status}`);
    if (response.headers.get("content-length") !== String(size)) throw new Error("range length must preserve the full video size");
    if (response.headers.get("content-range") !== `bytes 0-${size - 1}/${size}`) throw new Error("wrong Content-Range");
    const reader = response.body!.getReader();
    const first = await reader.read();
    if (first.done || first.value.byteLength > 64 * 1024) throw new Error("response must stream bounded chunks");
    if (new TextDecoder().decode(first.value.subarray(0, 8)) !== "ftyp-mp4") throw new Error("first range must start at byte zero");
    await reader.cancel();

    const headResponse = await fileRangeResponse(
      path,
      "video/mp4",
      new Request("http://localhost/api/media/test", { method: "HEAD" }),
    );
    if (headResponse.status !== 200 || headResponse.body !== null) throw new Error("HEAD must return metadata only");
    if (headResponse.headers.get("content-length") !== String(size)) throw new Error("HEAD must report the file size");

    const invalid = await fileRangeResponse(
      path,
      "video/mp4",
      new Request("http://localhost/api/media/test", { headers: { range: "bytes=0-1,4-5" } }),
    );
    if (invalid.status !== 416 || invalid.headers.get("content-range") !== `bytes */${size}`) {
      throw new Error("multiple ranges must be rejected with 416");
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
