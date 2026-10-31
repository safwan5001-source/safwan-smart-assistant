"""Manual Preview-only Neon health probe (never runs as a public endpoint).

Run from an authorized Preview environment with DATABASE_URL and VERCEL_ENV.
Prints only a minimal pass/fail code. Do not log connection exceptions, which
may include connection details.
"""
import sys
import psycopg
from app.neon_probe import probe_neon

def main() -> int:
    try:
        ok=probe_neon(psycopg.connect)
    except Exception:
        print("NEON_PREVIEW_PROBE_FAILED",file=sys.stderr)
        return 1
    print("NEON_PREVIEW_PROBE_OK" if ok else "NEON_PREVIEW_PROBE_FAILED")
    return 0 if ok else 1

if __name__=="__main__":
    raise SystemExit(main())
