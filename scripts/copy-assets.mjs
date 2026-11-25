import { cpSync, chmodSync } from "node:fs";
cpSync("src/player/player.js", "dist/player/player.js");
cpSync("src/player/player.css", "dist/player/player.css");
chmodSync("dist/cli/index.js", 0o755);
