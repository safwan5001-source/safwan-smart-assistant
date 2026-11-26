#!/usr/bin/env bash
# BASHT HQ — reproducible 3D asset build.
#
#   tools/hq-assets/build.sh all          # building + characters + publish
#   tools/hq-assets/build.sh building     # architecture, furniture, baked lightmap  (≈6 min on 4 CPU cores)
#   tools/hq-assets/build.sh characters   # BASHT robot (+ procedural stand-ins)    (≈10 s)
#   tools/hq-assets/build.sh humans       # 13 realistic people + mocap clip libraries from Microsoft Rocketbox (MIT) (≈1 min)
#                                         #   needs ROCKETBOX=<git clone of github.com/microsoft/Microsoft-Rocketbox>
#   tools/hq-assets/build.sh lineup       # QA render of all characters (idle + walk)
#   tools/hq-assets/build.sh publish      # meshopt-compress into apps/web/public/hq-assets/<version>/ + manifest
#
# Requirements: a Python with Blender as a module (pip install -r tools/hq-assets/requirements.txt) → HQ_BLENDER_PY,
# and `pnpm install` at the repo root (pins @gltf-transform/cli).
# Input: tools/hq-assets/layout.json, generated from apps/web/lib/hq/layout.ts (HQ_WRITE_LAYOUT=1 pnpm test:web).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PY="${HQ_BLENDER_PY:-python3}"
OUT="${HQ_OUT:-$HERE/out}"
mkdir -p "$OUT"
"$PY" -c "import bpy" 2>/dev/null || { echo "HQ_BLENDER_PY must point to a Python with bpy (pip install -r $HERE/requirements.txt)"; exit 1; }

case "${1:-all}" in
  building)   "$PY" "$HERE/blender/build_building.py" -- --out "$OUT" "${@:2}" ;;
  characters) "$PY" "$HERE/blender/build_characters.py" -- --out "$OUT" "${@:2}" ;;
  humans)     "$PY" "$HERE/blender/build_humans.py" -- --out "$OUT" "${@:2}" ;;
  lineup)     "$PY" "$HERE/blender/render_lineup.py" -- "$OUT" idle && "$PY" "$HERE/blender/render_lineup.py" -- "$OUT" walk ;;
  publish)    HQ_BLENDER_PY="$PY" node "$HERE/publish.mjs" "$OUT" "${@:2}" ;;
  all)        "$0" building && "$0" characters && "$0" humans && "$0" publish ;;
  *) echo "usage: $0 [all|building|characters|humans|lineup|publish]"; exit 2 ;;
esac
