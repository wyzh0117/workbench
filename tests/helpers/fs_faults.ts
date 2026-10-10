/**
 * Fault fixtures for "unreadable file" scenarios.
 *
 * POSIX: `chmod 000` denies reads. Windows ignores the read bits (the
 * read-only attribute only affects writes), so the helper installs an
 * explicit deny ACE for Everyone (S-1-1-0) and removes it again on restore.
 */

export async function denyFileRead(path: string): Promise<() => Promise<void>> {
  if (Deno.build.os !== "windows") {
    const original = (await Deno.lstat(path)).mode ?? 0o644;
    await Deno.chmod(path, 0o000);
    return async () => {
      await Deno.chmod(path, original);
    };
  }
  const run = async (...args: string[]) => {
    const command = new Deno.Command("icacls.exe", {
      args,
      stdin: "null",
      stdout: "null",
      stderr: "null",
    });
    const output = await command.output();
    if (output.code !== 0) {
      throw new Error(`icacls ${args.join(" ")} failed with code ${output.code}`);
    }
  };
  await run(path, "/deny", "*S-1-1-0:(R)");
  return async () => {
    await run(path, "/remove:d", "*S-1-1-0");
  };
}
