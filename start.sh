#!/usr/bin/env bash
# OW Bridge headless 启动脚本（macOS / Linux）
set -e
export BUDDY_NO_SYNC=1
exec node src/main.js
