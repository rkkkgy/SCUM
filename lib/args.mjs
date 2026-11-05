// 极简命令行参数解析：--key=value / --flag
export function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  for (const raw of argv) {
    const m = String(raw).match(/^--([^=]+)(?:=(.*))?$/);
    if (m) out[m[1]] = m[2] ?? true;
    else out[raw] = true;
  }
  return out;
}
