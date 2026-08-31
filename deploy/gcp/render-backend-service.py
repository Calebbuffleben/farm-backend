#!/usr/bin/env python3
"""Render Cloud Run multi-container YAML for service `backend`.

Usage:
  python3 render-backend-service.py \\
    --template backend.service.yaml \\
    --env-json nest-env.json \\
    --nest-image REGION-docker.pkg.dev/PROJECT/backend/backend:SHA \\
    --envoy-image REGION-docker.pkg.dev/PROJECT/backend/envoy:SHA \\
    --cloud-sql PROJECT:REGION:INSTANCE \\
    --sa-email SA@PROJECT.iam.gserviceaccount.com \\
    --region southamerica-east1 \\
    --out /tmp/backend.service.yaml

nest-env.json: flat object of Nest env vars (PORT / GRPC_* are forced by template).
Never print the output file (may contain secrets).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

FORCED = {
    "PORT": "3001",
    "GRPC_FEEDBACK_PORT": "50052",
    "GRPC_TLS_TERMINATED_AT_EDGE": "true",
}


def yaml_escape(value: str) -> str:
    # Always double-quote so YAML does not coerce true/false/null/numbers.
    escaped = (
        value.replace("\\", "\\\\")
        .replace('"', '\\"')
        .replace("\n", "\\n")
        .replace("\r", "\\r")
    )
    return f'"{escaped}"'


def nest_env_block(env: dict[str, str]) -> str:
    merged = {**env, **FORCED}
    lines: list[str] = []
    for key in sorted(merged.keys()):
        val = merged[key]
        if val is None:
            continue
        lines.append(f"            - name: {key}")
        lines.append(f"              value: {yaml_escape(str(val))}")
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--template", required=True, type=Path)
    ap.add_argument("--env-json", required=True, type=Path)
    ap.add_argument("--nest-image", required=True)
    ap.add_argument("--envoy-image", required=True)
    ap.add_argument("--cloud-sql", required=True)
    ap.add_argument("--sa-email", required=True)
    ap.add_argument("--region", default="southamerica-east1")
    ap.add_argument("--out", required=True, type=Path)
    args = ap.parse_args()

    raw = json.loads(args.env_json.read_text())
    if not isinstance(raw, dict):
        print("env-json must be an object", file=sys.stderr)
        return 1
    env = {str(k): "" if v is None else str(v) for k, v in raw.items()}

    template = args.template.read_text()
    for key, val in (
        ("__REGION__", args.region),
        ("__SA_EMAIL__", args.sa_email),
        ("__CLOUD_SQL__", args.cloud_sql),
        ("__NEST_IMAGE__", args.nest_image),
        ("__ENVOY_IMAGE__", args.envoy_image),
    ):
        template = template.replace(key, val)

    marker = "            # __NEST_ENV_EXTRA__"
    # Replace the whole env: block under nest with forced+extra.
    start = template.find("        - name: nest\n")
    if start < 0:
        print("nest container not found in template", file=sys.stderr)
        return 1
    env_key = template.find("\n          env:\n", start)
    resources_key = template.find("\n          resources:\n", env_key)
    if env_key < 0 or resources_key < 0:
        print("could not locate nest env/resources block", file=sys.stderr)
        return 1
    new_env = "\n          env:\n" + nest_env_block(env)
    rendered = template[: env_key] + new_env + template[resources_key:]
    rendered = rendered.replace(marker + "\n", "").replace(marker, "")

    args.out.write_text(rendered)
    print(f"wrote {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
