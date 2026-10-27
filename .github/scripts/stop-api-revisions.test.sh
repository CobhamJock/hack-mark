#!/usr/bin/env bash
set -euo pipefail

script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/stop-api-revisions.sh"
temp=$(mktemp -d)
trap 'rm -rf "$temp"' EXIT
export CALLS="$temp/calls"
export COUNTER="$temp/counter"

az() {
  echo "$*" >> "$CALLS"
  case "$1 $2 $3" in
    "containerapp list -g")
      [[ "$SCENARIO" != list-error ]] || return 1
      [[ "$SCENARIO" != absent ]] || return 0
      printf 'legacy-api\nprivate-api\n'
      ;;
    "containerapp revision list")
      [[ "$SCENARIO" != revision-error ]] || return 1
      if [[ " $* " == *" --all "* ]]; then
        printf 'active-rev\ninactive-rev\n'
      else
        echo active-rev
      fi
      ;;
    "containerapp revision deactivate")
      [[ "$SCENARIO" != deactivate-error ]] || return 1
      ;;
    "containerapp replica list")
      [[ "$SCENARIO" != replica-error ]] || return 1
      case "$SCENARIO" in
        invalid) echo unknown ;;
        empty) ;;
        timeout) echo 1 ;;
        waiting)
          local count
          count=$(cat "$COUNTER")
          echo $((count + 1)) > "$COUNTER"
          if [[ "$count" -lt 2 ]]; then echo 1; else echo 0; fi
          ;;
        *) echo 0 ;;
      esac
      ;;
    *) echo "Unexpected az command: $*" >&2; return 1 ;;
  esac
}
sleep() { :; }
export -f az sleep

check() {
  export SCENARIO=$1
  local expected=$2
  : > "$CALLS"
  echo 0 > "$COUNTER"
  local actual=0
  bash "$script" rg-test legacy-api private-api > "$temp/output" 2>&1 || actual=$?
  if [[ "$expected" == success && "$actual" -ne 0 ]] || [[ "$expected" == failure && "$actual" -eq 0 ]]; then
    cat "$temp/output"
    echo "FAIL: $SCENARIO (exit $actual)" >&2
    exit 1
  fi
  echo "PASS: $SCENARIO"
}

check absent success
if grep -q 'revision' "$CALLS"; then
  echo "Absent apps must not be queried for revisions" >&2
  exit 1
fi

check stopped success
for api in legacy-api private-api; do
  grep -q "revision deactivate -g rg-test -n $api --revision active-rev" "$CALLS"
  grep -q "replica list -g rg-test -n $api --revision inactive-rev" "$CALLS"
done

check waiting success
[[ "$(cat "$COUNTER")" -gt 2 ]]
for scenario in list-error revision-error deactivate-error replica-error invalid empty timeout; do
  check "$scenario" failure
done
