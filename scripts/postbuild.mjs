#!/usr/bin/env node
// Postbuild: guarantee dist/cli.js is a runnable executable.
//
// TypeScript usually preserves a leading `#!/usr/bin/env node` shebang, but we
// don't want the global command to depend on that quirk. This makes the result
// deterministic: ensure exactly one shebang on the first line and set the exec
// bit (a no-op on Windows, where npm uses the generated .cmd shim instead).
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const SHEBANG = "#!/usr/bin/env node";
const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPath = resolve(__dirname, "..", "dist", "cli.js");

let src = readFileSync(cliPath, "utf8");

// Strip any existing shebang line(s) so we never duplicate it, then prepend one.
while (src.startsWith("#!")) {
  const nl = src.indexOf("\n");
  src = nl === -1 ? "" : src.slice(nl + 1);
}
src = `${SHEBANG}\n${src}`;
writeFileSync(cliPath, src, "utf8");

try {
  chmodSync(cliPath, 0o755);
} catch {
  // Non-POSIX filesystems (Windows) don't support the exec bit — ignore.
}

console.log(`[postbuild] ensured shebang + exec bit on ${cliPath}`);
