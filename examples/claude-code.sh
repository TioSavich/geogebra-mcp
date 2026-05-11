#!/usr/bin/env bash
# Add this server to Claude Code (user-scoped, so it's available across projects).
set -e
claude mcp add geogebra --scope user -- npx -y @tiosavich/geogebra-mcp
