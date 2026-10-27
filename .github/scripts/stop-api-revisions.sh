#!/usr/bin/env bash
set -euo pipefail

rg=${1:?Resource group is required}
shift
[[ "$#" -gt 0 ]] || { echo "At least one API app name is required" >&2; exit 1; }

apps=$(az containerapp list -g "$rg" --query "[].name" -o tsv)
for api in "$@"; do
  if ! grep -Fxq "$api" <<< "$apps"; then
    echo "API app $api does not exist yet"
    continue
  fi

  # Include inactive revisions so earlier shutdowns cannot hide running replicas.
  revs=$(az containerapp revision list -g "$rg" -n "$api" --all --query "[].name" -o tsv)
  active=$(az containerapp revision list -g "$rg" -n "$api" --query "[?properties.active].name" -o tsv)
  for rev in $active; do
    az containerapp revision deactivate -g "$rg" -n "$api" --revision "$rev"
  done

  for i in $(seq 1 30); do
    running=0
    for rev in $revs; do
      n=$(az containerapp replica list -g "$rg" -n "$api" --revision "$rev" --query "length(@)" -o tsv)
      [[ "$n" =~ ^[0-9]+$ ]] || { echo "Invalid replica count for $api/$rev: $n" >&2; exit 1; }
      running=$((running + n))
    done
    echo "$api replicas still running: $running"
    [[ "$running" -eq 0 ]] && break
    [[ "$i" -lt 30 ]] || { echo "Old API replicas did not stop" >&2; exit 1; }
    sleep 10
  done
done
