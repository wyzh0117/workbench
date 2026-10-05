import { createSerialQueue } from "../../app/recovery.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("canonical saves coalesce cumulative revisions behind one in-flight write", async () => {
  const queue = createSerialQueue();
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => releaseFirst = resolve);
  const written: number[] = [];
  const write = (revision: number) => queue(async () => {
    written.push(revision);
    if (revision === 1) await firstGate;
  });

  const first = write(1);
  await Promise.resolve();
  const second = write(2);
  const third = write(3);
  assert(written.join(",") === "1", "r2 and r3 should wait behind the active write");
  releaseFirst();
  await Promise.all([first, second, third]);
  assert(written.join(",") === "1,3", "r2 should coalesce into the latest cumulative r3 snapshot");
});
