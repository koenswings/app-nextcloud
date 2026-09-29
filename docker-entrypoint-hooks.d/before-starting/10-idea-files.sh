#!/bin/sh
# 10-idea-files.sh — reconcile Nextcloud Local external storages with Files Disks
# (idea#137 / proposals/files-disk.md §9).
#
# Runs as www-data from the official image's before-starting hook folder.
# Enables files_external once, creates missing storages for folders under
# /mnt/idea-files/, deletes only storages this hook created whose folder is
# gone, and sets filesystem_check_changes so files added outside Nextcloud show.
# Deleting a storage removes Nextcloud config only — never files on disk.
#
# Own-storage marker: mount option idea_files=1 (set via files_external:option
# after create). Admin-created Local storages are never deleted, even when their
# datadir is under /mnt/idea-files/.
#
# Env (tests may override):
#   IDEA_FILES_ROOT  default /mnt/idea-files
#   IDEA_FILES_JSON  default .idea-files.json (Engine constant IDEA_FILES_JSON)
#   OCC              path to a single occ-compatible binary (default: use `php occ`)
set -eu

IDEA_FILES_ROOT="${IDEA_FILES_ROOT:-/mnt/idea-files}"
IDEA_FILES_JSON_NAME="${IDEA_FILES_JSON:-.idea-files.json}"
IDEA_FILES_JSON_PATH="${IDEA_FILES_ROOT}/${IDEA_FILES_JSON_NAME}"

run_occ() {
	if [ -n "${OCC:-}" ]; then
		"$OCC" "$@"
	else
		php occ "$@"
	fi
}

# Parse files_external:list --output=json → lines: id|mount_point|datadir|idea_files(0|1)
parse_list_json() {
	if command -v node >/dev/null 2>&1; then
		node -e '
const fs = require("fs");
let raw = fs.readFileSync(0, "utf8").trim();
if (!raw) process.exit(0);
let j;
try { j = JSON.parse(raw); } catch { process.exit(0); }
if (!Array.isArray(j)) process.exit(0);
for (const m of j) {
  const id = m.mount_id ?? m.id ?? "";
  const conf = m.configuration || {};
  const opt = m.options || {};
  const v = opt.idea_files;
  const idea = (v === true || v === 1 || v === "1" || v === "true") ? "1" : "0";
  const mp = String(m.mount_point || "").replace(/^\//, "");
  console.log([id, mp, conf.datadir || "", idea].join("|"));
}
'
	else
		php -r '
$raw = trim(stream_get_contents(STDIN));
if ($raw === "") exit(0);
$j = json_decode($raw, true);
if (!is_array($j)) exit(0);
foreach ($j as $m) {
  $id = $m["mount_id"] ?? $m["id"] ?? "";
  $conf = $m["configuration"] ?? [];
  $opt = $m["options"] ?? [];
  $v = $opt["idea_files"] ?? null;
  $idea = ($v === true || $v === 1 || $v === "1" || $v === "true") ? "1" : "0";
  $mp = ltrim((string)($m["mount_point"] ?? ""), "/");
  echo $id . "|" . $mp . "|" . ($conf["datadir"] ?? "") . "|" . $idea . "\n";
}
'
	fi
}

display_name_for() {
	# $1 = folder basename (slug-id6)
	folder="$1"
	if [ -f "$IDEA_FILES_JSON_PATH" ]; then
		if command -v node >/dev/null 2>&1; then
			name="$(node -e '
const fs=require("fs");
const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
const k=process.argv[2];
process.stdout.write((j && typeof j[k]==="string" && j[k]) ? j[k] : "");
' "$IDEA_FILES_JSON_PATH" "$folder" 2>/dev/null || true)"
		else
			name="$(php -r '
$j=json_decode(@file_get_contents($argv[1]), true);
$k=$argv[2];
echo (is_array($j) && isset($j[$k]) && is_string($j[$k]) && $j[$k] !== "") ? $j[$k] : "";
' "$IDEA_FILES_JSON_PATH" "$folder" 2>/dev/null || true)"
		fi
		if [ -n "${name:-}" ]; then
			printf '%s' "$name"
			return 0
		fi
	fi
	printf '%s' "$folder"
}

set_option() {
	# files_external:option <id> <key> <value>  (Nextcloud 31)
	# Some versions use: option <id> set <key> <value>
	id="$1"; key="$2"; val="$3"
	if run_occ files_external:option "$id" "$key" "$val" >/dev/null 2>&1; then
		return 0
	fi
	run_occ files_external:option "$id" set "$key" "$val" >/dev/null 2>&1 || true
}

# No Files Disk mounts yet — succeed so Nextcloud can start.
if [ ! -d "$IDEA_FILES_ROOT" ]; then
	echo "idea-files: ${IDEA_FILES_ROOT} absent — skip reconcile"
	exit 0
fi

# Fail closed if occ is not usable yet (first install / upgrade in progress).
if ! run_occ status >/dev/null 2>&1; then
	echo "idea-files: occ not ready — skip reconcile (fail closed, nothing deleted)"
	exit 0
fi

# Enable files_external once (idempotent).
if ! run_occ app:enable files_external >/dev/null 2>&1; then
	# Already enabled or transient failure — continue only if list works.
	if ! run_occ files_external:list --output=json >/dev/null 2>&1; then
		echo "idea-files: files_external unavailable — skip reconcile"
		exit 0
	fi
fi

list_json="$(run_occ files_external:list --output=json 2>/dev/null || echo '[]')"
list_lines="$(printf '%s' "$list_json" | parse_list_json || true)"

# Collect existing own storages keyed by datadir.
# Also track all datadirs that already have a storage (any owner) to stay idempotent.
tmp_own="$(mktemp)"
tmp_any="$(mktemp)"
trap 'rm -f "$tmp_own" "$tmp_any"' EXIT

printf '%s\n' "$list_lines" | while IFS= read -r line; do
	[ -n "$line" ] || continue
	id="${line%%|*}"; rest="${line#*|}"
	mp="${rest%%|*}"; rest="${rest#*|}"
	datadir="${rest%%|*}"; idea="${rest##*|}"
	[ -n "$datadir" ] && printf '%s\n' "$datadir" >> "$tmp_any"
	if [ "$idea" = "1" ]; then
		printf '%s|%s|%s\n' "$id" "$datadir" "$mp" >> "$tmp_own"
	fi
done

# Create missing storages for each top-level directory.
for dir in "$IDEA_FILES_ROOT"/*; do
	[ -e "$dir" ] || continue
	[ -d "$dir" ] || continue
	base="$(basename "$dir")"
	# Engine layout: never treat the JSON file as a folder (already skipped by -d).
	datadir="${IDEA_FILES_ROOT%/}/$base"
	if grep -Fxq "$datadir" "$tmp_any" 2>/dev/null; then
		# Already present (ours or admin). Ensure our marker + check-changes if ours.
		continue
	fi
	# Idempotent: also match if an own storage already points here (race-safe).
	if grep -F "|$datadir|" "$tmp_own" >/dev/null 2>&1; then
		continue
	fi
	name="$(display_name_for "$base")"
	echo "idea-files: create storage \"$name\" → $datadir"
	# Create returns mount id on stdout when --output=json (a bare number).
	new_id="$(run_occ files_external:create "$name" local null::null -c "datadir=$datadir" --output=json 2>/dev/null || true)"
	new_id="$(printf '%s' "$new_id" | tr -d '[:space:]')"
	if [ -z "$new_id" ] || ! printf '%s' "$new_id" | grep -Eq '^[0-9]+$'; then
		# Fallback: re-list and find by datadir
		list_json="$(run_occ files_external:list --output=json 2>/dev/null || echo '[]')"
		new_id="$(printf '%s' "$list_json" | parse_list_json | awk -F'|' -v d="$datadir" '$3==d {print $1; exit}')"
	fi
	if [ -n "$new_id" ]; then
		set_option "$new_id" idea_files 1
		set_option "$new_id" filesystem_check_changes 1
		printf '%s\n' "$datadir" >> "$tmp_any"
		printf '%s|%s|%s\n' "$new_id" "$datadir" "$name" >> "$tmp_own"
	else
		echo "idea-files: WARNING failed to create storage for $datadir"
	fi
done

# Refresh own list after creates, then delete own storages whose folder is gone.
list_json="$(run_occ files_external:list --output=json 2>/dev/null || echo '[]')"
printf '%s' "$list_json" | parse_list_json | while IFS= read -r line; do
	[ -n "$line" ] || continue
	id="${line%%|*}"; rest="${line#*|}"
	mp="${rest%%|*}"; rest="${rest#*|}"
	datadir="${rest%%|*}"; idea="${rest##*|}"
	[ "$idea" = "1" ] || continue
	# Only delete when datadir is under our root and the folder is gone.
	case "$datadir" in
		"$IDEA_FILES_ROOT"/*) ;;
		*) continue ;;
	esac
	if [ ! -d "$datadir" ]; then
		echo "idea-files: delete own storage id=$id (folder gone): $datadir"
		# -y: config only; never touches files on disk (folder already absent).
		run_occ files_external:delete -y "$id" >/dev/null 2>&1 || \
			run_occ files_external:delete --yes "$id" >/dev/null 2>&1 || true
	else
		# Keep filesystem_check_changes on for own storages that remain.
		set_option "$id" filesystem_check_changes 1
	fi
done

echo "idea-files: reconcile done"
exit 0
