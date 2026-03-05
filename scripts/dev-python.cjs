#!/usr/bin/env node
// Cross-platform launcher for the Python service.
// Uses Node.js path resolution instead of shell path syntax so it works on
// both Windows (cmd.exe doesn't support forward-slash relative exe paths) and
// Unix (no .venv/Scripts/).
const { spawnSync } = require("child_process");
const path = require("path");

const root = path.resolve(__dirname, "..");
const python =
  process.platform === "win32"
    ? path.join(root, "python_service", ".venv", "Scripts", "python.exe")
    : path.join(root, "python_service", ".venv", "bin", "python");

const script = path.join(root, "python_service", "music_processor.py");

const result = spawnSync(python, [script], { stdio: "inherit", env: process.env });
process.exit(result.status ?? 1);
