#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

CHERRY_INPUT="cherry-studio.202602071921.zip"
RIKKA_INPUT="rikkahub_backup_20260207_184206.zip"
OUT_DIR=".compare/latest"
MODE="content"
PROFILE_PATH="scripts/parity_profile.json"
STRICT=0

if [[ -n "${CHERRIKKA_CLI:-}" ]]; then
  read -r -a CLI_CMD <<<"$CHERRIKKA_CLI"
else
  CLI_CMD=(go run ./cmd/cherrikka)
fi

usage() {
  cat <<'EOF'
Usage:
  scripts/consistency_compare.sh [options]

Options:
  --cherry <path>   Cherry source backup zip path
  --rikka <path>    Rikka source backup zip path
  --out-dir <path>  Output directory (default: .compare/latest)
  --mode <mode>     Comparison mode: raw|content (default: content)
  --profile <path>  Parity profile JSON path (default: scripts/parity_profile.json)
  --strict          Exit non-zero when any difference exists
  -h, --help        Show this help

Env:
  CHERRIKKA_CLI     Override CLI command, e.g. "go run ./cmd/cherrikka" or "./cherrikka"

Behavior:
  1) Run CLI conversion and frontend-engine conversion for both directions.
  2) Unzip outputs and compare:
     - file list differences
     - normalized content differences (mode=content) OR raw byte differences (mode=raw)
  3) Write detailed reports under <out-dir>/reports.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cherry)
      CHERRY_INPUT="$2"
      shift 2
      ;;
    --rikka)
      RIKKA_INPUT="$2"
      shift 2
      ;;
    --out-dir)
      OUT_DIR="$2"
      shift 2
      ;;
    --mode)
      MODE="$2"
      shift 2
      ;;
    --profile)
      PROFILE_PATH="$2"
      shift 2
      ;;
    --strict)
      STRICT=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage
      exit 2
      ;;
  esac
done

if [[ ! -f "$CHERRY_INPUT" ]]; then
  echo "missing cherry source zip: $CHERRY_INPUT" >&2
  exit 2
fi
if [[ ! -f "$RIKKA_INPUT" ]]; then
  echo "missing rikka source zip: $RIKKA_INPUT" >&2
  exit 2
fi
if [[ "$MODE" != "raw" && "$MODE" != "content" ]]; then
  echo "invalid --mode value: $MODE (expected raw|content)" >&2
  exit 2
fi
if [[ "$MODE" == "content" && ! -f "$PROFILE_PATH" ]]; then
  echo "missing parity profile: $PROFILE_PATH" >&2
  exit 2
fi

mkdir -p "$OUT_DIR/zips" "$OUT_DIR/extract" "$OUT_DIR/reports"

abs_path() {
  local rel="$1"
  if [[ "$rel" = /* ]]; then
    printf "%s\n" "$rel"
  else
    printf "%s/%s\n" "$ROOT_DIR" "$rel"
  fi
}

run_conversions() {
  local cherry_abs
  local rikka_abs
  cherry_abs="$(abs_path "$CHERRY_INPUT")"
  rikka_abs="$(abs_path "$RIKKA_INPUT")"

  echo "[1/4] CLI convert Cherry -> Rikka"
  "${CLI_CMD[@]}" convert --input "$cherry_abs" --output "$OUT_DIR/zips/cli-c2r.zip" --from auto --to rikka >/dev/null

  echo "[2/4] FE  convert Cherry -> Rikka"
  (
    cd frontend
    npx vite-node scripts/convert_with_engine.ts \
      --input "$cherry_abs" \
      --output "$ROOT_DIR/$OUT_DIR/zips/fe-c2r.zip" \
      --from auto \
      --to rikka >/dev/null
  )

  echo "[3/4] CLI convert Rikka -> Cherry"
  "${CLI_CMD[@]}" convert --input "$rikka_abs" --output "$OUT_DIR/zips/cli-r2c.zip" --from auto --to cherry >/dev/null

  echo "[4/4] FE  convert Rikka -> Cherry"
  (
    cd frontend
    npx vite-node scripts/convert_with_engine.ts \
      --input "$rikka_abs" \
      --output "$ROOT_DIR/$OUT_DIR/zips/fe-r2c.zip" \
      --from auto \
      --to cherry >/dev/null
  )
}

build_json_filter_for_path() {
  local rel="$1"
  mapfile -t rules < <(jq -r --arg p "$rel" '.json[$p][]?' "$PROFILE_PATH")
  if [[ ${#rules[@]} -eq 0 ]]; then
    echo '.'
    return
  fi

  local del_expr=""
  local rule
  for rule in "${rules[@]}"; do
    if [[ -z "$rule" ]]; then
      continue
    fi
    local jq_path=".$rule"
    if [[ "$rule" == .* ]]; then
      jq_path="$rule"
    fi
    if [[ -z "$del_expr" ]]; then
      del_expr="$jq_path"
    else
      del_expr="$del_expr, $jq_path"
    fi
  done
  if [[ -z "$del_expr" ]]; then
    echo '.'
    return
  fi
  echo "del($del_expr)"
}

normalize_json_file() {
  local src="$1"
  local dst="$2"
  local rel="$3"

  if [[ "$rel" == "data.json" ]]; then
    normalize_cherry_data_json "$src" "$dst" "$rel"
    return
  fi

  local filter
  filter="$(build_json_filter_for_path "$rel")"
  if ! jq -S "$filter" "$src" > "$dst"; then
    cp "$src" "$dst"
  fi
}

normalize_cherry_data_json() {
  local src="$1"
  local dst="$2"
  local rel="$3"
  local filter
  local tmp

  filter="$(build_json_filter_for_path "$rel")"
  tmp="$(mktemp)"

  if ! jq -S "$filter" "$src" > "$tmp"; then
    cp "$src" "$dst"
    rm -f "$tmp"
    return
  fi

  if ! jq -S '
    def sk:
      if type == "object" then
        to_entries | sort_by(.key) | map({ key: .key, value: (.value | sk) }) | from_entries
      elif type == "array" then
        map(sk)
      else
        .
      end;

    def normalize_persist:
      (
        try (
          fromjson
          | with_entries(
              .value |= (if type == "string" then (try fromjson catch .) else . end)
            )
          | if ((.assistants | type) == "object") then
              .assistants |= (
                .assistants |= (
                  ((.assistants // []) | if type == "array" then . else [] end)
                  | map(
                      if type == "object" then
                        .topics = (
                          ((.topics // []) | if type == "array" then . else [] end)
                          | map(
                              if (
                                type == "object"
                                and ((.name // "") == "New Topic")
                                and ((.isNameManuallyEdited // true) == false)
                                and (((.messages // []) | if type == "array" then . else [] end | length) == 0)
                              ) then
                                .id = "__RANDOM_TOPIC_ID__"
                                | .createdAt = "__RANDOM_TIME__"
                                | .updatedAt = "__RANDOM_TIME__"
                              else
                                .
                              end
                            )
                        )
                      else
                        .
                      end
                    )
                )
              )
            else
              .
            end
          | if ((.settings | type) == "object") then
              .settings.userId = "__RANDOM_USER_ID__"
            else
              .
            end
          | with_entries(
              .value |= (if (type == "object" or type == "array") then ((. | sk) | tojson) else . end)
            )
          | (. | sk)
          | tojson
        ) catch .
      );

    if (
      (.localStorage | type) == "object"
      and ((.localStorage["persist:cherry-studio"] // null) | type) == "string"
    ) then
      .localStorage["persist:cherry-studio"] |= normalize_persist
    else
      .
    end
  ' "$tmp" > "$dst"; then
    cp "$tmp" "$dst"
  fi

  rm -f "$tmp"
}

sqlite_table_exists() {
  local db="$1"
  local table="$2"
  local count
  count="$(sqlite3 "$db" "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='$table';" 2>/dev/null || echo 0)"
  [[ "$count" == "1" ]]
}

normalize_sqlite_file() {
  local src="$1"
  local dst="$2"
  local rel="$3"
  local strip_message_id=0
  if jq -e --arg p "$rel" '.sqlite[$p].stripMessageFields[]? | select(. == "id")' "$PROFILE_PATH" >/dev/null; then
    strip_message_id=1
  fi

  {
    echo "# sqlite:$rel"

    echo "[ConversationEntity]"
    if sqlite_table_exists "$src" "ConversationEntity"; then
      sqlite3 "$src" -tabs -noheader "SELECT id, assistant_id, title, nodes, truncate_index, suggestions, is_pinned FROM ConversationEntity ORDER BY id;"
    else
      echo "<missing-table>"
    fi

    echo "[managed_files]"
    if sqlite_table_exists "$src" "managed_files"; then
      sqlite3 "$src" -tabs -noheader "SELECT folder, relative_path, display_name, mime_type, size_bytes FROM managed_files ORDER BY relative_path;"
    else
      echo "<missing-table>"
    fi

    echo "[message_node]"
    if sqlite_table_exists "$src" "message_node"; then
      sqlite3 "$src" -tabs -noheader \
        "SELECT conversation_id, node_index, json_quote(messages), select_index FROM message_node ORDER BY conversation_id, node_index;" \
        | while IFS=$'\t' read -r conversation_id node_index messages_quoted select_index; do
          normalized_messages=""
          if [[ "$strip_message_id" -eq 1 ]]; then
            normalized_messages="$(
              printf '%s' "$messages_quoted" \
                | jq -cS 'fromjson | (fromjson? // .) | if type=="array" then map(if type=="object" then del(.id) else . end) else . end' 2>/dev/null \
                || printf '%s' "$messages_quoted"
            )"
          else
            normalized_messages="$(
              printf '%s' "$messages_quoted" \
                | jq -cS 'fromjson | (fromjson? // .)' 2>/dev/null \
                || printf '%s' "$messages_quoted"
            )"
          fi
          printf '%s\t%s\t%s\t%s\n' "$conversation_id" "$node_index" "$normalized_messages" "$select_index"
        done
    else
      echo "<missing-table>"
    fi
  } > "$dst"
}

normalize_content_file() {
  local src="$1"
  local dst="$2"
  local rel="$3"
  if jq -e --arg p "$rel" '.sqlite[$p] != null' "$PROFILE_PATH" >/dev/null; then
    normalize_sqlite_file "$src" "$dst" "$rel"
    return
  fi
  if [[ "$rel" == *.json ]]; then
    normalize_json_file "$src" "$dst" "$rel"
    return
  fi
  cp "$src" "$dst"
}

compare_pair() {
  local label="$1"
  local cli_zip="$2"
  local fe_zip="$3"
  local pair_dir="$OUT_DIR/extract/$label"
  local report_dir="$OUT_DIR/reports/$label"
  local normalized_dir="$report_dir/normalized"

  mkdir -p "$pair_dir/cli" "$pair_dir/fe" "$report_dir"
  if [[ "$MODE" == "content" ]]; then
    mkdir -p "$normalized_dir/cli" "$normalized_dir/fe"
  fi

  unzip -qq -o "$cli_zip" -d "$pair_dir/cli"
  unzip -qq -o "$fe_zip" -d "$pair_dir/fe"

  (
    cd "$pair_dir/cli"
    find . -type f | LC_ALL=C sort
  ) > "$report_dir/files.cli.txt"
  (
    cd "$pair_dir/fe"
    find . -type f | LC_ALL=C sort
  ) > "$report_dir/files.fe.txt"

  if diff -u "$report_dir/files.cli.txt" "$report_dir/files.fe.txt" > "$report_dir/file-list.diff"; then
    : > "$report_dir/file-list.diff"
  fi

  comm -23 "$report_dir/files.cli.txt" "$report_dir/files.fe.txt" > "$report_dir/only-in-cli.txt"
  comm -13 "$report_dir/files.cli.txt" "$report_dir/files.fe.txt" > "$report_dir/only-in-fe.txt"
  comm -12 "$report_dir/files.cli.txt" "$report_dir/files.fe.txt" > "$report_dir/in-both.txt"

  : > "$report_dir/content-hash-diff.tsv"
  while IFS= read -r rel_path; do
    local rel
    local cli_src
    local fe_src
    local cli_cmp
    local fe_cmp
    local cli_hash
    local fe_hash

    rel="${rel_path#./}"
    cli_src="$pair_dir/cli/$rel"
    fe_src="$pair_dir/fe/$rel"
    cli_cmp="$cli_src"
    fe_cmp="$fe_src"

    if [[ "$MODE" == "content" ]]; then
      cli_cmp="$normalized_dir/cli/$rel"
      fe_cmp="$normalized_dir/fe/$rel"
      mkdir -p "$(dirname "$cli_cmp")" "$(dirname "$fe_cmp")"
      normalize_content_file "$cli_src" "$cli_cmp" "$rel"
      normalize_content_file "$fe_src" "$fe_cmp" "$rel"
    fi

    cli_hash="$(sha256sum "$cli_cmp" | awk '{print $1}')"
    fe_hash="$(sha256sum "$fe_cmp" | awk '{print $1}')"
    if [[ "$cli_hash" != "$fe_hash" ]]; then
      printf "%s\t%s\t%s\n" "$rel_path" "$cli_hash" "$fe_hash" >> "$report_dir/content-hash-diff.tsv"
    fi
  done < "$report_dir/in-both.txt"

  local cli_only_count
  local fe_only_count
  local both_count
  local content_diff_count

  cli_only_count="$(wc -l < "$report_dir/only-in-cli.txt" | tr -d ' ')"
  fe_only_count="$(wc -l < "$report_dir/only-in-fe.txt" | tr -d ' ')"
  both_count="$(wc -l < "$report_dir/in-both.txt" | tr -d ' ')"
  content_diff_count="$(wc -l < "$report_dir/content-hash-diff.tsv" | tr -d ' ')"

  {
    echo "pair=$label"
    echo "mode=$MODE"
    echo "cli_only_files=$cli_only_count"
    echo "fe_only_files=$fe_only_count"
    echo "common_files=$both_count"
    echo "content_diff_files=$content_diff_count"
  } > "$report_dir/summary.txt"

  echo "[$label][$MODE] cli_only=$cli_only_count fe_only=$fe_only_count common=$both_count diff_content=$content_diff_count"
}

run_conversions

echo "Comparing extracted files (mode=$MODE)..."
compare_pair "c2r" "$OUT_DIR/zips/cli-c2r.zip" "$OUT_DIR/zips/fe-c2r.zip"
compare_pair "r2c" "$OUT_DIR/zips/cli-r2c.zip" "$OUT_DIR/zips/fe-r2c.zip"

cat > "$OUT_DIR/reports/README.txt" <<EOF
Consistency comparison completed.

Mode: $MODE
Profile: $PROFILE_PATH

Output structure:
- $OUT_DIR/zips: CLI and frontend generated zip artifacts.
- $OUT_DIR/extract: unzipped trees for each pair.
- $OUT_DIR/reports/c2r and $OUT_DIR/reports/r2c:
  - files.cli.txt / files.fe.txt
  - only-in-cli.txt / only-in-fe.txt
  - in-both.txt
  - content-hash-diff.tsv
  - summary.txt
  - normalized/* (mode=content only)
EOF

cat "$OUT_DIR/reports/c2r/summary.txt"
cat "$OUT_DIR/reports/r2c/summary.txt"

if [[ "$STRICT" -eq 1 ]]; then
  c2r_diff_count="$(awk -F= '/^(cli_only_files|fe_only_files|content_diff_files)=/{sum += $2} END {print sum+0}' "$OUT_DIR/reports/c2r/summary.txt")"
  r2c_diff_count="$(awk -F= '/^(cli_only_files|fe_only_files|content_diff_files)=/{sum += $2} END {print sum+0}' "$OUT_DIR/reports/r2c/summary.txt")"
  total_diff=$((c2r_diff_count + r2c_diff_count))
  if [[ "$total_diff" -ne 0 ]]; then
    echo "STRICT mode: differences detected, exiting with code 1" >&2
    exit 1
  fi
fi

echo "Done. Reports written to: $OUT_DIR/reports"
