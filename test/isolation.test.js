// The suite runs with an empty home folder (scripts/test.cjs). smolcoder
// reads the user's own settings from there — ~/.omlx, MTPLX's and LM Studio's
// files, ~/.smolcoder — so a real home makes results depend on what the
// developer has installed: with oMLX set up, the local key won over the one a
// test meant to send, and "identified by /health" failed on exactly the Macs
// that run oMLX.
const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");

test("tests never see the developer's real home folder", () => {
  assert.match(path.basename(os.homedir()), /^smol-test-home-/, `home is ${os.homedir()}`);
});
