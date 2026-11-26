#!/usr/bin/env bash
# BASHT HQ — reproducible 3D asset build.
#
#   tools/hq-assets/build.sh all          # building + characters + publish
#   tools/hq-assets/build.sh building     # architecture, furniture, baked lightmap  (≈6 min on 4 CPU cores)
#   tools/hq-assets/build.sh characters   # 14 skinned characters with clips        (≈10 s)
#   tools/hq-assets/build.sh lineup       # QA render of all characters (idle + walk)
#   tools/hq-assets/build.sh publish      # meshopt-compress into apps/web/public/hq-assets/<version>/ + manifest
#
# Requirements: a Python with Blender as a module (pip install bpy==5.3.0 numpy) → HQ_BLENDER_PY, and Node/npx.
# Input: tools/hq-assets/layout.json, generated from apps/web/lib/hq/layout.ts (HQ_WRITE_LAYOUT=1 pnpm test:web).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PY="${HQ_BLENDER_PY:-python3}"
OUT="${HQ_OUT:-$HERE/out}"
mkdir -p "$OUT"
"$PY" -c "import bpy" 2>/dev/null || { echo "HQ_BLENDER_PY must point to a Python with bpy (pip install bpy==5.3.0 numpy)"; exit 1; }

case "${1:-all}" in
  building)   "$PY" "$HERE/blender/build_building.py" -- --out "$OUT" "${@:2}" ;;
  characters) "$PY" "$HERE/blender/build_characters.py" -- --out "$OUT" "${@:2}" ;;
  lineup)     "$PY" "$HERE/blender/render_lineup.py" -- "$OUT" idle && "$PY" "$HERE/blender/render_lineup.py" -- "$OUT" walk ;;
  publish)    node "$HERE/publish.mjs" "$OUT" ;;
  all)        "$0" building && "$0" characters && "$0" publish ;;
  *) echo "usage: $0 [all|building|characters|lineup|publish]"; exit 2 ;;
esac
