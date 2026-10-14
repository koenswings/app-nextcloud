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
#   OCC              path to a single occ-compatible binary (default: php /var/www/html/occ)
#   IDEA_TEACHERS_GROUP  group that sees the Files Disk storages (default: teachers).
#                    Own storages are limited to this group + admin via
#                    files_external:applicable; the group is created when missing.
#                    Groups an admin added to a storage are kept.
#   IDEA_OCC_WAIT    seconds to wait for occ/DB to come up (default 120)
#   IDEA_OCC_INTERVAL seconds between occ readiness checks (default 3)
#
# Fail open: always exits 0 so Nextcloud starts; nothing is deleted when occ is
# not usable.
set -eu

IDEA_FILES_ROOT="${IDEA_FILES_ROOT:-/mnt/idea-files}"
IDEA_FILES_JSON_NAME="${IDEA_FILES_JSON:-.idea-files.json}"
IDEA_FILES_JSON_PATH="${IDEA_FILES_ROOT}/${IDEA_FILES_JSON_NAME}"

run_occ() {
	if [ -n "${OCC:-}" ]; then
		"$OCC" "$@"
	else
		php /var/www/html/occ "$@"
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
  const sh = opt.enable_sharing;
  const share = (sh === true || sh === 1 || sh === "1" || sh === "true") ? "1" : "0";
  const groups = (Array.isArray(m.applicable_groups) ? m.applicable_groups : []).join(",");
  console.log([id, mp, conf.datadir || "", idea, share, groups].join("|"));
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
  $sh = $opt["enable_sharing"] ?? null;
  $share = ($sh === true || $sh === 1 || $sh === "1" || $sh === "true") ? "1" : "0";
  $groups = implode(",", is_array($m["applicable_groups"] ?? null) ? $m["applicable_groups"] : []);
  echo $id . "|" . $mp . "|" . ($conf["datadir"] ?? "") . "|" . $idea . "|" . $share . "|" . $groups . "\n";
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

# Wait for occ: on container start MariaDB is often still coming up, so a single
# `occ status` fails ("occ not ready", seen on wh 2026-10-13). Retry with a bound.
# Not installed → nothing to reconcile (no wait). Timeout → skip, delete nothing.
OCC_WAIT="${IDEA_OCC_WAIT:-120}"
OCC_INTERVAL="${IDEA_OCC_INTERVAL:-3}"
case "$OCC_WAIT" in ''|*[!0-9]*) OCC_WAIT=120 ;; esac
case "$OCC_INTERVAL" in ''|*[!0-9]*|0) OCC_INTERVAL=3 ;; esac
waited=0
while :; do
	st="$(run_occ status 2>/dev/null)" && st_ok=1 || st_ok=0
	if [ "$st_ok" = 1 ]; then
		case "$st" in
			*"installed: true"*) break ;;
			*"installed: false"*)
				echo "idea-files: Nextcloud not installed — skip reconcile"
				exit 0 ;;
			*) break ;;  # status ok but unknown format: proceed
		esac
	fi
	if [ "$waited" -ge "$OCC_WAIT" ]; then
		echo "idea-files: occ not ready after ${OCC_WAIT}s — skip reconcile (nothing deleted)"
		exit 0
	fi
	sleep "$OCC_INTERVAL"
	waited=$((waited + OCC_INTERVAL))
done
[ "$waited" -gt 0 ] && echo "idea-files: occ ready after ${waited}s"

TEACHERS_GROUP="${IDEA_TEACHERS_GROUP:-teachers}"
if ! printf '%s' "$TEACHERS_GROUP" | grep -Eq '^[A-Za-z0-9_.@-]{1,64}$'; then
	echo "idea-files: WARNING IDEA_TEACHERS_GROUP '$TEACHERS_GROUP' invalid — storages not restricted"
	TEACHERS_GROUP=""
fi

# Ensure own storage <id> has sharing, check-changes, and teachers+admin applicable.
# $2 = current enable_sharing (0|1), $3 = current applicable groups (comma list).
# Writes only what differs (idempotent).
ensure_own() {
	id="$1"; share="$2"; groups=",$3,"
	[ "$share" = "1" ] || set_option "$id" enable_sharing true
	set_option "$id" filesystem_check_changes 1
	[ -n "$TEACHERS_GROUP" ] || return 0
	for g in "$TEACHERS_GROUP" admin; do
		case "$groups" in *",$g,"*) continue ;; esac
		if run_occ files_external:applicable "$id" --add-group="$g" >/dev/null 2>&1; then
			echo "idea-files: storage id=$id visible to group $g"
		else
			echo "idea-files: WARNING could not restrict storage id=$id to group $g"
		fi
	done
}

# Teachers group: create when missing (group:add fails harmlessly if it exists).
if [ -n "$TEACHERS_GROUP" ]; then
	if ! run_occ group:list --output=json 2>/dev/null | grep -Fq "\"$TEACHERS_GROUP\""; then
		run_occ group:add "$TEACHERS_GROUP" >/dev/null 2>&1 \
			&& echo "idea-files: created group $TEACHERS_GROUP" || true
	fi
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
	datadir="${rest%%|*}"; rest="${rest#*|}"; idea="${rest%%|*}"
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
	datadir="${rest%%|*}"; rest="${rest#*|}"
	idea="${rest%%|*}"; rest="${rest#*|}"
	share="${rest%%|*}"; groups="${rest#*|}"
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
		# Own storages that remain: sharing, check-changes, teachers+admin only.
		ensure_own "$id" "$share" "$groups"
	fi
done

echo "idea-files: reconcile done"
exit 0
