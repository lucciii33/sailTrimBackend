const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

// Launch Playwright's built-in recorder (codegen) against `url`. It opens a real
// browser the user drives by hand; Playwright records every action and, on
// close, writes a full playwright-test spec which we read back and return.
//
// codegen needs @playwright/test available in its cwd. Configurable via
// E2E_RECORDER_CWD; defaults to the sibling oliviatools repo where Playwright
// is installed. (This is the local-dev recorder; the productized remote-record
// flow comes later.)
// Options:
//   loadStorage   — path to a storageState JSON to start ALREADY logged in.
//   saveStorage   — path to write the storageState to after recording (used to
//                   capture the login session once, at the project level).
//   requireSpec   — reject if no actions were recorded (false when we only care
//                   about capturing the auth session).
function recordSpec(url, { loadStorage, saveStorage, requireSpec = true } = {}) {
  return new Promise((resolve, reject) => {
    const outFile = path.join(os.tmpdir(), `rec-${crypto.randomUUID()}.spec.ts`);
    const cwd =
      process.env.E2E_RECORDER_CWD ||
      path.resolve(__dirname, "../../../oliviatools");

    const args = ["playwright", "codegen", "--target=playwright-test", "-o", outFile];
    if (loadStorage) args.push(`--load-storage=${loadStorage}`);
    if (saveStorage) args.push(`--save-storage=${saveStorage}`);
    args.push(url);

    const cp = spawn("npx", args, { cwd, stdio: "ignore" });

    cp.on("error", (err) => {
      const e = new Error(
        `Could not launch the recorder (is Playwright installed in ${cwd}?): ${err.message}`
      );
      e.statusCode = 500;
      reject(e);
    });

    cp.on("close", () => {
      let spec = "";
      try {
        spec = fs.readFileSync(outFile, "utf8");
      } catch (_) {
        /* file may not exist if nothing was recorded */
      }
      fs.promises.unlink(outFile).catch(() => {});
      if (requireSpec && !spec.trim()) {
        const e = new Error(
          "Recording was empty — the browser closed before any actions were captured."
        );
        e.statusCode = 422;
        return reject(e);
      }
      resolve(spec);
    });
  });
}

module.exports = { recordSpec };
