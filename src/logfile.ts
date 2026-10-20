import { createWriteStream } from "node:fs";

/**
 * Copies stdout and stderr to LOG_FILE, each line stamped with the time. Docker's own log is per container, so every
 * deploy (a new color) started it empty and took the old color's lines with it: `gaql check false positive` and the
 * job errors were gone within a day. Production points it at a host file both colors append to (O_APPEND, line-sized
 * writes, so a cutover's lines interleave without corrupting). Off when unset (tests, stdio, self-hosters). If the file
 * can't be written, the process carries on with stdout alone.
 */
export function teeToFile(path: string | undefined): void {
  if (!path) return;
  const file = createWriteStream(path, { flags: "a" });
  let ok = true;
  file.on("error", (e) => { ok = false; process.stderr.write(`log file ${path}: ${e.message}\n`); });
  let lineStart = true;
  const stamp = (chunk: string) => {
    let out = "";
    for (const part of chunk.split(/(?<=\n)/)) {
      if (lineStart) out += `${new Date().toISOString()} `;
      out += part;
      lineStart = part.endsWith("\n");
    }
    return out;
  };
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream) as (...a: unknown[]) => boolean;
    stream.write = ((chunk: unknown, ...rest: unknown[]) => {
      if (ok) file.write(stamp(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString()));
      return write(chunk, ...rest);
    }) as typeof stream.write;
  }
}
